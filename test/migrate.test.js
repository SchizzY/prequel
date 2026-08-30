// Migrating a real-shaped legacy store. The fixture below matches what the
// pre-SQLite commentStore actually wrote: a flat array where replies point at
// a parent, anchors live on the root comment, and the only two authors
// possible were 'user' and 'claude'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { openDb } from '../src/db/index.js';
import { migrateStore, findLegacyStores } from '../src/db/migrateJson.js';
import { listPulls, ensureRepo } from '../src/model/pulls.js';
import { listParticipants } from '../src/model/participants.js';
import * as threads from '../src/model/threads.js';

const REPO_ROOT = 'U:/some-project';

const LEGACY = {
  repoRoot: REPO_ROOT,
  comments: [
    {
      id: 'c1',
      repoRoot: REPO_ROOT,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      status: 'open',
      filePath: 'src/app.js',
      side: 'new',
      startLine: 12,
      endLine: 14,
      body: 'This should be extracted.',
      branch: 'feature-a',
      lineSnapshot: ['function a() {', '  return 1;', '}'],
      author: 'user',
      parentId: null,
    },
    {
      id: 'c2',
      createdAt: '2026-08-01T10:05:00.000Z',
      body: 'Extracted to `parseHunk`.',
      author: 'claude',
      parentId: 'c1',
      filePath: 'src/app.js',
      side: 'new',
      startLine: 12,
      endLine: 14,
      branch: 'feature-a',
      lineSnapshot: [],
    },
    {
      id: 'c3',
      createdAt: '2026-08-01T11:00:00.000Z',
      status: 'resolved',
      filePath: 'README.md',
      side: 'file',
      startLine: 0,
      endLine: 0,
      body: 'Whole-file note.',
      branch: 'feature-a',
      author: 'user',
      parentId: null,
      lineSnapshot: [],
    },
    {
      id: 'c4',
      createdAt: '2026-07-01T09:00:00.000Z',
      status: 'open',
      filePath: 'old.js',
      side: 'new',
      startLine: 3,
      endLine: 3,
      body: 'Predates branch tracking.',
      branch: null,
      author: 'user',
      parentId: null,
      lineSnapshot: ['let x = 1;'],
    },
    // an orphan: its parent was deleted at some point
    {
      id: 'c5',
      createdAt: '2026-08-02T09:00:00.000Z',
      body: 'Reply to something long gone.',
      author: 'claude',
      parentId: 'deleted-parent',
      branch: 'feature-a',
    },
  ],
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-mig-'));
  const store = path.join(dir, 'abc123.json');
  fs.writeFileSync(store, JSON.stringify(LEGACY, null, 2));
  const db = openDb(path.join(dir, 'prequel.db'));
  return { db, store, dir };
}

test('legacy stores are discovered by shape, not just extension', () => {
  const { store, dir } = setup();
  fs.writeFileSync(path.join(dir, 'not-a-store.json'), JSON.stringify({ hello: 'world' }));
  const found = findLegacyStores(dir);
  assert.deepEqual(found, [store]);
});

test('a legacy store becomes PRs, participants, threads and comments', () => {
  const { db, store } = setup();
  const stats = migrateStore(db, store);

  assert.equal(stats.repoRoot, REPO_ROOT);
  assert.equal(stats.threads, 3, 'three root comments became three threads');
  assert.equal(stats.comments, 4, 'three roots plus one surviving reply');
  assert.equal(stats.skipped, 1, 'the orphaned reply is skipped');

  // one PR per branch, plus a catch-all for the null branch
  const repo = ensureRepo(db, REPO_ROOT);
  const pulls = listPulls(db, repo.id);
  assert.equal(pulls.length, 2);
  assert.deepEqual(pulls.map((p) => p.head_ref).sort(), ['feature-a', 'unknown']);

  // 'user' and 'claude' became real participants, with claude typed as an agent
  const people = listParticipants(db);
  assert.deepEqual(people.map((p) => p.handle).sort(), ['claude', 'user']);
  assert.equal(people.find((p) => p.handle === 'claude').kind, 'agent');
  assert.equal(people.find((p) => p.handle === 'user').kind, 'human');
});

test('anchors, replies and resolved state survive the move', () => {
  const { db, store } = setup();
  migrateStore(db, store);
  const repo = ensureRepo(db, REPO_ROOT);
  const feature = listPulls(db, repo.id).find((p) => p.head_ref === 'feature-a');
  const list = threads.listThreads(db, feature.id);

  const inline = list.find((t) => t.file_path === 'src/app.js');
  assert.equal(inline.start_line, 12);
  assert.equal(inline.end_line, 14);
  assert.deepEqual(inline.line_snapshot, ['function a() {', '  return 1;', '}']);
  // the reply is now a second message on the thread, not a separate row
  assert.equal(inline.comments.length, 2);
  assert.deepEqual(inline.comments.map((c) => c.handle), ['user', 'claude']);
  assert.deepEqual(inline.comments.map((c) => c.seq), [0, 1]);

  // a whole-file comment keeps side='file' and carries no line anchor
  const fileLevel = list.find((t) => t.file_path === 'README.md');
  assert.equal(fileLevel.side, 'file');
  assert.equal(fileLevel.start_line, null);
  assert.equal(fileLevel.status, 'resolved');
  assert.ok(fileLevel.resolved_at);
});

test('migrating twice does not duplicate anything', () => {
  const { db, store } = setup();
  const first = migrateStore(db, store);
  const second = migrateStore(db, store);

  assert.equal(second.threads, 0, 'nothing new on the second pass');
  assert.equal(second.pulls, 0, 'PRs are reused, not recreated');

  const repo = ensureRepo(db, REPO_ROOT);
  const total = listPulls(db, repo.id).reduce(
    (n, p) => n + threads.listThreads(db, p.id).length,
    0
  );
  assert.equal(total, first.threads);
});

test('migrated threads are unassigned and unrated, and the queue tolerates it', () => {
  const { db, store } = setup();
  migrateStore(db, store);
  const repo = ensureRepo(db, REPO_ROOT);
  const feature = listPulls(db, repo.id).find((p) => p.head_ref === 'feature-a');
  const claude = listParticipants(db).find((p) => p.handle === 'claude');

  const list = threads.listThreads(db, feature.id);
  assert.ok(list.every((t) => t.severity === null && t.assignee_id === null));

  // unassigned work is up for grabs, so it still surfaces
  const queue = threads.workQueue(db, { pullRequestId: feature.id, participantId: claude.id });
  assert.equal(queue.length, 1, 'the one open thread on this branch');
  assert.equal(queue[0].file_path, 'src/app.js');
});
