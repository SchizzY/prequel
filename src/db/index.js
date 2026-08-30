// SQLite-backed store. Uses node:sqlite (built in since Node 22.5) so there is
// no native module to compile — important on Windows.
//
// WAL + busy_timeout is what makes concurrent reviewers safe: several agents
// read while one writes, and a writer that collides retries instead of
// erroring. Every mutation below is a single statement, so there is no
// read-modify-write window in which one agent's comment can overwrite another's.

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

export function openDb(dbPath = DEFAULT_DB_PATH) {
  // recursive:true still throws EPERM on a drive root (Windows), so only
  // create the parent when it is actually missing.
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get();
  if (row?.version >= 1) return;
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
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
