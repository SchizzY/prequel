// The reason this store exists. The original comment store did
//   read whole JSON file -> mutate array -> write whole file
// with no lock across the three. Two agents posting at once is not something
// it can survive.
//
// These tests run real concurrent OS processes against both designs.
//
// Note on the failure mode: the read-modify-write race can silently drop a
// comment, but on Windows it usually does not get that far -- two processes
// renaming their temp file onto the same destination fails with EPERM and the
// writer dies mid-review instead. Both outcomes are data loss; the test accepts
// either and reports which one happened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const WRITERS = 4;
const PER_WRITER = 25;

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-conc-'));

// ESM cannot import a bare Windows path: "U:/..." parses as a URL scheme.
const mod = (rel) => JSON.stringify(pathToFileURL(path.join(repoRoot, rel)).href);

/** Start `count` processes at once; resolve with each one's exit code. */
function runConcurrently(script, count, args) {
  const file = path.join(tmpdir(), 'writer.mjs');
  fs.writeFileSync(file, script);
  return Promise.all(
    Array.from({ length: count }, (_, i) => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [file, ...args, String(i)], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      p.stderr.on('data', (d) => (stderr += d));
      p.on('exit', (code) => resolve({ code, stderr }));
      p.on('error', reject);
    }))
  );
}

test('the original read-modify-write design cannot survive concurrent writers', async (t) => {
  const dir = tmpdir();
  const store = path.join(dir, 'comments.json');
  fs.writeFileSync(store, JSON.stringify({ comments: [] }));

  // A faithful reduction of the original store: read all, push, write all, via
  // an atomic temp+rename. Each write is atomic; the sequence around it is not.
  const script = `
    import fs from 'node:fs';
    const [store, per, id] = [process.argv[2], Number(process.argv[3]), process.argv[4]];
    for (let i = 0; i < per; i++) {
      const all = JSON.parse(fs.readFileSync(store, 'utf8')).comments;
      all.push({ writer: id, i });
      const tmp = store + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ comments: all }));
      fs.renameSync(tmp, store);
    }
  `;
  const results = await runConcurrently(script, WRITERS, [store, String(PER_WRITER)]);

  const crashed = results.filter((r) => r.code !== 0).length;
  const kept = JSON.parse(fs.readFileSync(store, 'utf8')).comments.length;
  const expected = WRITERS * PER_WRITER;

  assert.ok(
    crashed > 0 || kept < expected,
    `expected data loss or a crash, but all ${WRITERS} writers succeeded and kept all ${kept}`
  );
  t.diagnostic(
    `JSON store: ${crashed}/${WRITERS} writers crashed; kept ${kept} of ${expected} comments`
  );
});

test('the SQLite store keeps every comment under the same concurrency', async (t) => {
  const dir = tmpdir();
  const dbPath = path.join(dir, 'prequel.db');

  const { openDb } = await import('../src/db/index.js');
  const { ensureParticipant } = await import('../src/model/participants.js');
  const { ensureRepo, createPull } = await import('../src/model/pulls.js');
  const threads = await import('../src/model/threads.js');

  const db = openDb(dbPath);
  const author = ensureParticipant(db, { handle: 'cahill' });
  const repo = ensureRepo(db, dir, 'conc');
  const pr = createPull(db, {
    repoId: repo.id,
    title: 'concurrency',
    authorId: author.id,
    baseRef: 'main',
    headRef: 'x',
  });
  const thread = threads.createThread(db, {
    pullRequestId: pr.id,
    participantId: author.id,
    filePath: 'a.js',
    startLine: 1,
    body: 'root',
  });
  for (let i = 0; i < WRITERS; i++) {
    ensureParticipant(db, { handle: `agent${i}`, agentId: `agent-${i}` });
  }
  db.close();

  const script = `
    import { openDb } from ${mod('src/db/index.js')};
    import { getByHandle } from ${mod('src/model/participants.js')};
    import { addComment } from ${mod('src/model/threads.js')};
    const [dbPath, threadId, per, id] = [process.argv[2], process.argv[3], Number(process.argv[4]), process.argv[5]];
    const db = openDb(dbPath);
    const me = getByHandle(db, 'agent' + id);
    for (let i = 0; i < per; i++) {
      addComment(db, { threadId, participantId: me.id, body: 'from ' + id + ' #' + i });
    }
    db.close();
  `;
  const results = await runConcurrently(script, WRITERS, [dbPath, thread.id, String(PER_WRITER)]);
  const failed = results.filter((r) => r.code !== 0);
  assert.equal(failed.length, 0, `writers failed:\n${failed.map((f) => f.stderr).join('\n')}`);

  const check = openDb(dbPath);
  const full = threads.getThread(check, thread.id);
  const expected = WRITERS * PER_WRITER + 1; // + the opening comment

  assert.equal(full.comments.length, expected, 'no comment was lost');

  // seq must be a dense 0..n-1 range: no gaps, no duplicates. UNIQUE(thread_id,
  // seq) would have thrown on a duplicate, so a clean run also proves no writer
  // read a stale MAX(seq).
  assert.deepEqual(
    full.comments.map((c) => c.seq),
    [...Array(expected).keys()],
    'seq is dense and ordered'
  );

  for (let i = 0; i < WRITERS; i++) {
    assert.equal(
      full.comments.filter((c) => c.handle === `agent${i}`).length,
      PER_WRITER,
      `agent${i} kept all its comments`
    );
  }
  t.diagnostic(`SQLite store: ${WRITERS} concurrent writers, kept ${full.comments.length}/${expected}`);
  check.close();
});
