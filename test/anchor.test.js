// Comment anchoring: the part that decides whether a review comment still
// points at the code it was written about.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { relocate, reanchorPull } from '../src/anchor/reanchor.js';
import { openDb } from '../src/db/index.js';
import { ensureParticipant } from '../src/model/participants.js';
import { ensureRepo, createPull } from '../src/model/pulls.js';
import * as threads from '../src/model/threads.js';
import { getBlobSha } from '../src/git/gitService.js';

const FILE = ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 2;', '}'];

describe('relocate', () => {
  test('code that has not moved stays put', () => {
    const r = relocate(FILE, ['  return 1;'], 2);
    assert.deepEqual(r, { anchorState: 'current', startLine: 2, endLine: 2, moved: false });
  });

  test('code pushed down by an insertion above is followed', () => {
    const shifted = ['// added', '// added', ...FILE];
    const r = relocate(shifted, ['  return 1;'], 2);
    assert.equal(r.anchorState, 'current');
    assert.equal(r.startLine, 4);
    assert.equal(r.moved, true);
  });

  test('code pulled up by a deletion above is followed', () => {
    const r = relocate(FILE.slice(3), ['  return 2;'], 6);
    assert.equal(r.anchorState, 'current');
    assert.equal(r.startLine, 3);
    assert.equal(r.moved, true);
  });

  test('a multi-line snapshot keeps its span', () => {
    const r = relocate(['x', ...FILE], ['function a() {', '  return 1;', '}'], 1);
    assert.equal(r.startLine, 2);
    assert.equal(r.endLine, 4);
  });

  test('re-indented code is found but flagged outdated', () => {
    const reindented = FILE.map((l) => (l.startsWith('  ') ? '    ' + l.trim() : l));
    const r = relocate(reindented, ['  return 1;'], 2);
    assert.equal(r.anchorState, 'outdated', 'recognisably there, but touched');
    assert.equal(r.startLine, 2);
  });

  test('deleted code is lost, not silently re-pointed', () => {
    const without = FILE.filter((l) => l !== '  return 1;');
    const r = relocate(without, ['  return 1;'], 2);
    assert.equal(r.anchorState, 'lost');
    // the hint is preserved so a human can still see where it used to be
    assert.equal(r.startLine, 2);
  });

  test('a deleted file loses every comment on it', () => {
    assert.equal(relocate(null, ['  return 1;'], 2).anchorState, 'lost');
  });

  test('duplicated code resolves to the nearest match', () => {
    const dup = ['  return 1;', 'x', 'y', 'z', '  return 1;'];
    assert.equal(relocate(dup, ['  return 1;'], 5).startLine, 5);
    assert.equal(relocate(dup, ['  return 1;'], 1).startLine, 1);
    // a hint in the middle picks whichever is closer
    assert.equal(relocate(dup, ['  return 1;'], 4).startLine, 5);
  });

  test('without a snapshot, only the line range can be checked', () => {
    // a comment can be filed without a snapshot
    assert.equal(relocate(FILE, [], 3).anchorState, 'current');
    assert.equal(relocate(FILE, null, 3).anchorState, 'current');
    assert.equal(relocate(FILE, [], 99).anchorState, 'lost', 'past the end of the file');
  });
});

describe('reanchorPull against a real repo', () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-anchor-'));
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'app.js'), FILE.join('\n') + '\n');
    git('add', '-A');
    git('commit', '-qm', 'initial');

    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-anchor-db-'));
    const db = openDb(path.join(dbDir, 'prequel.db'));
    const human = ensureParticipant(db, { handle: 'cahill' });
    const claude = ensureParticipant(db, { handle: 'claude', agentId: 'claude-code' });
    const repo = ensureRepo(db, dir);
    const pull = createPull(db, {
      repoId: repo.id,
      title: 'anchoring',
      authorId: human.id,
      baseRef: 'main',
      headRef: 'main',
    });
    return { dir, db, pull, human, claude };
  }

  const write = (dir, lines) => fs.writeFileSync(path.join(dir, 'app.js'), lines.join('\n') + '\n');

  async function addThread(db, dir, pull, human, { startLine, snapshot }) {
    return threads.createThread(db, {
      pullRequestId: pull.id,
      participantId: human.id,
      filePath: 'app.js',
      side: 'new',
      startLine,
      lineSnapshot: snapshot,
      severity: 'blocking',
      body: 'look at this',
      blobSha: await getBlobSha(dir, { rev: 'WORKTREE', path: 'app.js' }),
    });
  }

  test('an untouched file is skipped without rescanning', async () => {
    const { dir, db, pull, human } = setup();
    await addThread(db, dir, pull, human, { startLine: 2, snapshot: ['  return 1;'] });

    const changes = await reanchorPull(db, { repoRoot: dir, pullRequestId: pull.id });
    assert.equal(changes.length, 0, 'blob sha matches, so nothing to do');
  });

  test('inserting code above a comment moves it', async () => {
    const { dir, db, pull, human } = setup();
    const thread = await addThread(db, dir, pull, human, {
      startLine: 2,
      snapshot: ['  return 1;'],
    });

    write(dir, ['// a new header', '// another line', ...FILE]);
    const changes = await reanchorPull(db, { repoRoot: dir, pullRequestId: pull.id });

    assert.equal(changes.length, 1);
    assert.equal(changes[0].from, 2);
    assert.equal(changes[0].to, 4);
    assert.equal(changes[0].moved, true);

    const after = threads.getThread(db, thread.id);
    assert.equal(after.start_line, 4);
    assert.equal(after.anchor_state, 'current');
  });

  test('deleting the commented code marks it lost and clears the queue', async () => {
    const { dir, db, pull, human, claude } = setup();
    const thread = await addThread(db, dir, pull, human, {
      startLine: 2,
      snapshot: ['  return 1;'],
    });
    threads.assign(db, thread.id, claude.id);

    assert.equal(
      threads.workQueue(db, { pullRequestId: pull.id, participantId: claude.id }).length,
      1
    );

    write(dir, FILE.filter((l) => l !== '  return 1;'));
    await reanchorPull(db, { repoRoot: dir, pullRequestId: pull.id });

    const after = threads.getThread(db, thread.id);
    assert.equal(after.anchor_state, 'lost');
    // still there for a human to look at, but no longer handed to an agent
    assert.equal(
      threads.workQueue(db, { pullRequestId: pull.id, participantId: claude.id }).length,
      0
    );
    assert.equal(threads.listThreads(db, pull.id).length, 1);
  });

  test('reformatting flags a comment outdated rather than dropping it', async () => {
    const { dir, db, pull, human } = setup();
    const thread = await addThread(db, dir, pull, human, {
      startLine: 2,
      snapshot: ['  return 1;'],
    });

    write(dir, FILE.map((l) => (l.startsWith('  ') ? '    ' + l.trim() : l)));
    await reanchorPull(db, { repoRoot: dir, pullRequestId: pull.id });

    const after = threads.getThread(db, thread.id);
    assert.equal(after.anchor_state, 'outdated');
    assert.equal(after.start_line, 2);
  });

  test('a deleted file loses its comments', async () => {
    const { dir, db, pull, human } = setup();
    await addThread(db, dir, pull, human, { startLine: 2, snapshot: ['  return 1;'] });

    fs.rmSync(path.join(dir, 'app.js'));
    await reanchorPull(db, { repoRoot: dir, pullRequestId: pull.id });

    assert.equal(threads.listThreads(db, pull.id)[0].anchor_state, 'lost');
  });

  test('several comments on one file all move together', async () => {
    const { dir, db, pull, human } = setup();
    const first = await addThread(db, dir, pull, human, {
      startLine: 2,
      snapshot: ['  return 1;'],
    });
    const second = await addThread(db, dir, pull, human, {
      startLine: 6,
      snapshot: ['  return 2;'],
    });

    write(dir, ['// header', ...FILE]);
    const changes = await reanchorPull(db, { repoRoot: dir, pullRequestId: pull.id });

    assert.equal(changes.length, 2);
    assert.equal(threads.getThread(db, first.id).start_line, 3);
    assert.equal(threads.getThread(db, second.id).start_line, 7);
  });

  test('a whole-file comment is never relocated', async () => {
    const { dir, db, pull, human } = setup();
    const thread = threads.createThread(db, {
      pullRequestId: pull.id,
      participantId: human.id,
      filePath: 'app.js',
      side: 'file',
      body: 'this file needs splitting',
    });

    write(dir, ['// totally different', 'content']);
    await reanchorPull(db, { repoRoot: dir, pullRequestId: pull.id });

    assert.equal(threads.getThread(db, thread.id).anchor_state, 'current');
  });

  test('re-anchoring is idempotent', async () => {
    const { dir, db, pull, human } = setup();
    await addThread(db, dir, pull, human, { startLine: 2, snapshot: ['  return 1;'] });

    write(dir, ['// header', ...FILE]);
    const first = await reanchorPull(db, { repoRoot: dir, pullRequestId: pull.id });
    const second = await reanchorPull(db, { repoRoot: dir, pullRequestId: pull.id });

    assert.equal(first.length, 1);
    assert.equal(second.length, 0, 'the second pass has nothing left to do');
  });
});

describe('the reanchor endpoint', () => {
  test('reports what moved, and the Files tab re-anchors on its own', async () => {
    const { createServer } = await import('../src/server.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-anchor-api-'));
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'app.js'), FILE.join('\n') + '\n');
    git('add', '-A');
    git('commit', '-qm', 'initial');

    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-anchor-api-db-'));
    const app = createServer({ repoRoot: dir, dbPath: path.join(dbDir, 'prequel.db') });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (u, b) =>
      fetch(base + u, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b ?? {}),
      }).then((r) => r.json());

    try {
      await post('/api/participants', { handle: 'cahill' });
      await post('/api/participants', { handle: 'claude', agentId: 'claude-code' });
      await post('/api/pulls', {
        handle: 'cahill',
        title: 'anchoring',
        baseRef: 'main',
        headRef: 'main',
        diffMode: 'working',
      });

      const created = await post('/api/pulls/1/threads', {
        handle: 'cahill',
        filePath: 'app.js',
        side: 'new',
        startLine: 2,
        severity: 'blocking',
        assignee: 'claude',
        lineSnapshot: ['  return 1;'],
        body: 'this one',
      });
      // the server records the file version it was written against
      assert.ok(created.thread.blob_sha, 'blob sha captured at creation');

      // nothing has changed yet
      assert.equal((await post('/api/pulls/1/reanchor')).changed, 0);

      fs.writeFileSync(path.join(dir, 'app.js'), ['// header', ...FILE].join('\n') + '\n');
      const moved = await post('/api/pulls/1/reanchor');
      assert.equal(moved.changed, 1);
      assert.equal(moved.moved, 1);
      assert.equal(moved.changes[0].from, 2);
      assert.equal(moved.changes[0].to, 3);

      // delete the code: the thread goes lost and leaves the agent queue
      fs.writeFileSync(
        path.join(dir, 'app.js'),
        FILE.filter((l) => l !== '  return 1;').join('\n') + '\n'
      );
      const lost = await post('/api/pulls/1/reanchor');
      assert.equal(lost.lost, 1);

      const queue = await fetch(`${base}/api/pulls/1/queue?handle=claude`).then((r) => r.json());
      assert.equal(queue.queue.length, 0, 'a lost thread is not handed to an agent');

      // and viewing the diff re-anchors without being asked
      fs.writeFileSync(path.join(dir, 'app.js'), FILE.join('\n') + '\n');
      await fetch(`${base}/pr/1/files`);
      const recovered = await fetch(`${base}/api/pulls/1/threads`).then((r) => r.json());
      assert.equal(recovered.threads[0].anchor_state, 'current', 'restored code re-anchors');
    } finally {
      server.close();
    }
  });
});
