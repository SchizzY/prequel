// SQLite-backed store. Uses node:sqlite (built in since Node 22.5) so there is
// no native module to compile — important on Windows.
//
// WAL + busy_timeout is what makes concurrent reviewers safe: several agents
// read while one writes, and a writer that collides waits instead of erroring.
// Turning WAL *on* is the exception -- see enableWal -- because SQLite does not
// run the busy handler for that lock. Every mutation below is a single
// statement, so there is no read-modify-write window in which one agent's
// comment can overwrite another's.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DB_PATH = path.join(os.homedir(), '.prequel', 'prequel.db');

// node:sqlite hands back null-prototype rows; callers (and JSON.stringify of
// nested structures) are happier with plain objects.
export const plain = (row) => (row ? { ...row } : row);
export const plainAll = (rows) => rows.map(plain);

// Switching a store into WAL takes a brief exclusive lock. Setting busy_timeout
// first covers it in the measurements taken here, but only in those: whether
// SQLite runs the busy handler for this particular lock upgrade is version and
// timing dependent, and it was observed failing outright often enough on a
// brand new store -- the multi-agent fan-out this store exists for -- to be
// worth not relying on. With no catch anywhere above, that failure kills the
// process before the server ever starts.
//
// So the pragma is retried explicitly, which costs nothing when it succeeds
// first time (the common case), and if it still will not take we carry on: a
// store left in the default rollback journal is slower under concurrent
// readers but entirely correct, which beats refusing to start.
function enableWal(db, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return true;
    } catch {
      // Another process is mid-switch. It only has to win once: whoever gets
      // there first puts the file in WAL for everybody.
      const until = Date.now() + 20;
      while (Date.now() < until) {
        /* brief spin; openDb is synchronous and runs once at startup */
      }
    }
  }
  return false;
}

export function openDb(dbPath = DEFAULT_DB_PATH) {
  // recursive:true still throws EPERM on a drive root (Windows), so only
  // create the parent when it is actually missing.
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  enableWal(db);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

// Applied in order; a database records how many of them it has seen. Adding a
// step is appending to this array -- never editing one that has shipped, since
// stores in the wild have already run it.
const MIGRATIONS = [
  // 1: the initial schema.
  (db) => db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')),

  // 2: pull request numbers are unique across the whole store, not per repo.
  // One server now lists pull requests from several repos, so /pr/7 has to
  // mean exactly one thing. Existing numbers are kept wherever they can be;
  // only the second and later claimants of a number move.
  (db) => {
    const rows = db.prepare('SELECT id, number FROM pull_request ORDER BY created_at, number').all();
    let max = rows.reduce((m, r) => Math.max(m, r.number), 0);
    const taken = new Set();
    const update = db.prepare('UPDATE pull_request SET number = ? WHERE id = ?');
    for (const row of rows) {
      if (!taken.has(row.number)) {
        taken.add(row.number);
        continue;
      }
      max += 1;
      taken.add(max);
      update.run(max, row.id);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS pull_number_unique ON pull_request (number)');
  },

  // 3: pull request numbers are issued from a counter, so that deleting a PR
  // does not hand its number to the next one. The unique index only says no
  // two live rows share a number; it does not say a number is never reused,
  // and a reused /pr/7 is a worse failure than a gap in the sequence.
  (db) => {
    // One row, structurally: `id = 0` makes a second allocator row impossible
    // rather than merely unlikely, so the unqualified UPDATE that bumps the
    // counter can never touch more or fewer than the one row it means.
    db.exec(
      'CREATE TABLE IF NOT EXISTS pull_number (id INTEGER PRIMARY KEY CHECK (id = 0), next INTEGER NOT NULL)'
    );
    if (!db.prepare('SELECT next FROM pull_number').get()) {
      const { max } = db
        .prepare('SELECT COALESCE(MAX(number), 0) AS max FROM pull_request')
        .get();
      db.prepare('INSERT INTO pull_number (id, next) VALUES (0, ?)').run(max + 1);
    }
  },
];

const versionOf = (db) => db.prepare('SELECT version FROM schema_version').get()?.version ?? 0;

// Several processes open the same store at once -- the server, an agent's CLI,
// a second window -- so the steps and the version they record have to move
// together. The read outside the transaction is the common case (nothing to
// do); the moment there is work, the write lock decides who does it, and the
// loser re-reads the version and finds it already done.
function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  if (versionOf(db) >= MIGRATIONS.length) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    const stored = db.prepare('SELECT version FROM schema_version').get();
    const at = stored?.version ?? 0;
    for (let i = at; i < MIGRATIONS.length; i++) MIGRATIONS[i](db);
    if (stored) db.prepare('UPDATE schema_version SET version = ?').run(MIGRATIONS.length);
    else db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(MIGRATIONS.length);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

// Run `fn` inside a transaction, rolling back if it throws. node:sqlite has no
// transaction helper of its own.
//
// IMMEDIATE, not a plain BEGIN: every caller here reads-then-writes (allocating
// the next comment.seq or pull_request.number). A deferred transaction takes
// the write lock only at the first write, so two agents could both read the
// same MAX() and one would clobber the other -- the exact lost-update the JSON
// store suffered from. IMMEDIATE takes the write lock up front, and
// busy_timeout makes the loser wait rather than fail.
// Re-entrant: the model functions call each other (migration wraps createPull,
// which wraps its own tx), and SQLite has no nested BEGIN. The outermost call
// owns the commit; inner ones just run. An inner throw still propagates, so the
// outermost rolls the whole thing back.
const depth = new WeakMap();

export function tx(db, fn) {
  const level = depth.get(db) ?? 0;
  if (level > 0) {
    depth.set(db, level + 1);
    try {
      return fn();
    } finally {
      depth.set(db, level);
    }
  }

  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

export const now = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
