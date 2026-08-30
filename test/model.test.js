// End-to-end exercise of the flow the old store could not express:
// two agents review the same PR, one addresses the other's findings, they
// disagree in a thread, and a triage pass dedupes across them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { openDb } from '../src/db/index.js';
import { ensureParticipant, listParticipants } from '../src/model/participants.js';
import { ensureRepo, createPull, tabCounts, updatePull } from '../src/model/pulls.js';
import { getOrCreatePending, submitReview, listReviews, verdictSummary } from '../src/model/reviews.js';
import * as threads from '../src/model/threads.js';
import { addEvent, listTimeline } from '../src/model/timeline.js';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-test-'));
  return openDb(path.join(dir, 'test.db'));
}

function seed(db) {
  const human = ensureParticipant(db, { handle: 'cahill', displayName: 'Cahill' });
  const claude = ensureParticipant(db, { handle: 'claude', displayName: 'Claude', agentId: 'claude-code' });
  const codex = ensureParticipant(db, { handle: 'codex', displayName: 'Codex', agentId: 'codex' });
  const repo = ensureRepo(db, 'U:/prequel', 'prequel');
  const pr = createPull(db, {
    repoId: repo.id,
    title: 'Add SQLite store',
    body: 'Replaces the JSON comment store.',
    authorId: human.id,
    baseRef: 'main',
    headRef: 'multi-reviewer',
  });
  return { human, claude, codex, repo, pr };
}

test('participants: humans and agents are the same shape', (t) => {
  const db = freshDb();
  const { claude, human } = seed(db);
  assert.equal(claude.kind, 'agent');
  assert.equal(claude.agent_id, 'claude-code');
  assert.equal(human.kind, 'human');
  assert.equal(human.agent_id, null);
  // idempotent by handle: an agent can register on every run
  assert.equal(ensureParticipant(db, { handle: 'claude' }).id, claude.id);
  assert.equal(listParticipants(db).length, 3);
});

test('PRs are numbered per repo', (t) => {
  const db = freshDb();
  const { repo, human } = seed(db);
  const second = createPull(db, {
    repoId: repo.id,
    title: 'Second',
    authorId: human.id,
    baseRef: 'main',
    headRef: 'other',
  });
  assert.equal(second.number, 2);
});

test('two agents review the same PR without colliding', (t) => {
  const db = freshDb();
  const { pr, claude, codex, human } = seed(db);

  const claudeReview = getOrCreatePending(db, { pullRequestId: pr.id, participantId: claude.id });
  const codexReview = getOrCreatePending(db, { pullRequestId: pr.id, participantId: codex.id });
  assert.notEqual(claudeReview.id, codexReview.id, 'each reviewer gets their own draft');

  // calling again returns the same draft, not a second one
  assert.equal(
    getOrCreatePending(db, { pullRequestId: pr.id, participantId: claude.id }).id,
    claudeReview.id
  );

  threads.createThread(db, {
    pullRequestId: pr.id,
    participantId: claude.id,
    reviewId: claudeReview.id,
    filePath: 'src/db/index.js',
    side: 'new',
    startLine: 42,
    severity: 'blocking',
    category: 'correctness',
    body: 'This transaction is deferred; it needs BEGIN IMMEDIATE.',
    lineSnapshot: ["  db.exec('BEGIN');"],
  });
  threads.createThread(db, {
    pullRequestId: pr.id,
    participantId: codex.id,
    reviewId: codexReview.id,
    filePath: 'src/db/index.js',
    side: 'new',
    startLine: 42,
    severity: 'blocking',
    body: 'Race here: two writers can read the same MAX(seq).',
  });
  threads.createThread(db, {
    pullRequestId: pr.id,
    participantId: codex.id,
    reviewId: codexReview.id,
    filePath: 'src/model/pulls.js',
    side: 'new',
    startLine: 7,
    severity: 'nit',
    body: 'Name this `nextNumber`.',
  });

  submitReview(db, claudeReview.id, { body: 'One blocking issue in the tx helper.', verdict: 'request_changes' });
  submitReview(db, codexReview.id, { body: 'Same tx issue, plus a naming nit.', verdict: 'request_changes' });

  const reviews = listReviews(db, pr.id, { state: 'submitted' });
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews.map((r) => r.handle).sort(), ['claude', 'codex']);
  assert.equal(reviews.find((r) => r.handle === 'codex').thread_count, 2);

  const verdicts = verdictSummary(db, pr.id);
  assert.equal(verdicts.length, 2);
  assert.ok(verdicts.every((v) => v.verdict === 'request_changes'));
});

test('work queue separates author from addressee', (t) => {
  const db = freshDb();
  const { pr, claude, codex } = seed(db);

  const review = getOrCreatePending(db, { pullRequestId: pr.id, participantId: claude.id });
  // Claude finds it, Codex is asked to fix it.
  const t1 = threads.createThread(db, {
    pullRequestId: pr.id,
    participantId: claude.id,
    reviewId: review.id,
    filePath: 'src/db/index.js',
    startLine: 42,
    severity: 'blocking',
    assigneeId: codex.id,
    body: 'Needs BEGIN IMMEDIATE.',
  });

  // The old model could not do this: the comment's author is an agent, so an
  // `author=user` queue would never surface it to anyone.
  const codexQueue = threads.workQueue(db, { pullRequestId: pr.id, participantId: codex.id });
  assert.equal(codexQueue.length, 1);
  assert.equal(codexQueue[0].id, t1.id);

  // and Claude does not pick up its own finding
  const claudeQueue = threads.workQueue(db, { pullRequestId: pr.id, participantId: claude.id });
  assert.equal(claudeQueue.length, 0, 'assigned elsewhere, so not in Claude queue');
});

test('work queue orders by severity and honours the severity filter', (t) => {
  const db = freshDb();
  const { pr, claude, codex } = seed(db);
  for (const [severity, line] of [['nit', 1], ['blocking', 2], ['question', 3], ['suggestion', 4]]) {
    threads.createThread(db, {
      pullRequestId: pr.id,
      participantId: claude.id,
      filePath: 'a.js',
      startLine: line,
      severity,
      assigneeId: codex.id,
      body: severity,
    });
  }
  const q = threads.workQueue(db, { pullRequestId: pr.id, participantId: codex.id });
  assert.deepEqual(
    q.map((t) => t.severity),
    ['blocking', 'suggestion', 'question', 'nit']
  );

  const urgent = threads.workQueue(db, {
    pullRequestId: pr.id,
    participantId: codex.id,
    severity: ['blocking'],
  });
  assert.equal(urgent.length, 1);
});

test('threads nest arbitrarily deep and record mentions', (t) => {
  const db = freshDb();
  const { pr, claude, codex, human } = seed(db);

  const thread = threads.createThread(db, {
    pullRequestId: pr.id,
    participantId: claude.id,
    filePath: 'src/db/index.js',
    startLine: 42,
    severity: 'blocking',
    body: 'Needs BEGIN IMMEDIATE.',
  });

  // The old store rejected this outright: "cannot reply to a reply".
  threads.addComment(db, { threadId: thread.id, participantId: codex.id, body: 'Disagree, @claude - WAL already serialises writers.' });
  threads.addComment(db, { threadId: thread.id, participantId: claude.id, body: 'Not for read-then-write. @codex see the MAX(seq) select.' });
  threads.addComment(db, { threadId: thread.id, participantId: codex.id, body: 'Fair. Conceded.' });
  threads.addComment(db, { threadId: thread.id, participantId: human.id, body: 'Going with IMMEDIATE.' });

  const full = threads.getThread(db, thread.id);
  assert.equal(full.comments.length, 5, 'opening comment plus four replies');
  assert.deepEqual(full.comments.map((c) => c.seq), [0, 1, 2, 3, 4]);
  assert.deepEqual(full.comments.map((c) => c.handle), ['claude', 'codex', 'claude', 'codex', 'cahill']);

  // mentions are how an agent learns it was addressed
  const claudeInbox = threads.inbox(db, claude.id);
  assert.equal(claudeInbox.length, 1);
  assert.equal(claudeInbox[0].from_handle, 'codex');
  assert.equal(threads.markMentionsSeen(db, claude.id), 1);
  assert.equal(threads.inbox(db, claude.id).length, 0);
});

test('conversation-level threads coexist with anchored ones', (t) => {
  const db = freshDb();
  const { pr, human, claude } = seed(db);

  threads.createThread(db, { pullRequestId: pr.id, participantId: human.id, body: 'Overall this looks right.' });
  threads.createThread(db, { pullRequestId: pr.id, participantId: claude.id, filePath: 'a.js', startLine: 3, body: 'inline' });

  const counts = tabCounts(db, pr.id);
  assert.equal(counts.conversation, 1);
  assert.equal(counts.files, 1);

  const conversation = threads.listThreads(db, pr.id, { anchored: false });
  assert.equal(conversation.length, 1);
  assert.equal(conversation[0].file_path, null);
  assert.equal(conversation[0].side, null);

  const inline = threads.listThreads(db, pr.id, { anchored: true });
  assert.equal(inline.length, 1);
  assert.equal(inline[0].file_path, 'a.js');
});

test('triage links duplicates and disagreements across reviewers', (t) => {
  const db = freshDb();
  const { pr, claude, codex, human } = seed(db);

  const a = threads.createThread(db, { pullRequestId: pr.id, participantId: claude.id, filePath: 'x.js', startLine: 42, body: 'tx is deferred' });
  const b = threads.createThread(db, { pullRequestId: pr.id, participantId: codex.id, filePath: 'x.js', startLine: 42, body: 'MAX(seq) race' });

  threads.linkThreads(db, b.id, a.id, 'duplicate_of', human.id);
  threads.linkThreads(db, b.id, a.id, 'duplicate_of', human.id); // idempotent

  const links = threads.listLinks(db, pr.id);
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, 'duplicate_of');
  assert.equal(links[0].to_thread_id, a.id);
});

test('resolution records who resolved it, and clears on reopen', (t) => {
  const db = freshDb();
  const { pr, claude, codex } = seed(db);
  const thread = threads.createThread(db, { pullRequestId: pr.id, participantId: claude.id, filePath: 'x.js', startLine: 1, body: 'fix' });

  const resolved = threads.setStatus(db, thread.id, 'resolved', codex.id);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolved_by_id, codex.id);
  assert.ok(resolved.resolved_at);

  const reopened = threads.setStatus(db, thread.id, 'open');
  assert.equal(reopened.resolved_by_id, null);
  assert.equal(reopened.resolved_at, null);

  // resolved work drops out of the queue
  threads.setStatus(db, thread.id, 'resolved', codex.id);
  assert.equal(threads.workQueue(db, { pullRequestId: pr.id, participantId: codex.id }).length, 0);
});

test('lost anchors drop out of the work queue', (t) => {
  const db = freshDb();
  const { pr, claude, codex } = seed(db);
  const thread = threads.createThread(db, { pullRequestId: pr.id, participantId: claude.id, filePath: 'x.js', startLine: 1, body: 'fix' });

  threads.setAnchorState(db, thread.id, 'outdated');
  assert.equal(threads.workQueue(db, { pullRequestId: pr.id, participantId: codex.id }).length, 1, 'outdated is still actionable');

  threads.setAnchorState(db, thread.id, 'lost');
  assert.equal(threads.workQueue(db, { pullRequestId: pr.id, participantId: codex.id }).length, 0, 'lost is not');
});

test('timeline records the PR story in order', (t) => {
  const db = freshDb();
  const { pr, human, claude } = seed(db);
  addEvent(db, { pullRequestId: pr.id, participantId: human.id, kind: 'opened' });
  addEvent(db, { pullRequestId: pr.id, participantId: claude.id, kind: 'review_submitted', payload: { verdict: 'request_changes', threads: 2 } });

  const events = listTimeline(db, pr.id);
  assert.deepEqual(events.map((e) => e.kind), ['opened', 'review_submitted']);
  assert.equal(events[1].payload.verdict, 'request_changes');
  assert.equal(events[1].handle, 'claude');
});

test('schema rejects malformed rows', (t) => {
  const db = freshDb();
  const { pr, claude } = seed(db);
  // an agent must carry a registry id
  assert.throws(() =>
    db.prepare("INSERT INTO participant (id, kind, handle, display_name) VALUES ('x','agent','y','y')").run()
  );
  // a submitted review must have a verdict
  assert.throws(() =>
    db
      .prepare("INSERT INTO review (id, pull_request_id, participant_id, state) VALUES ('r',?,?,'submitted')")
      .run(pr.id, claude.id)
  );
  // half an anchor is not allowed
  assert.throws(() =>
    db
      .prepare("INSERT INTO thread (id, pull_request_id, file_path) VALUES ('t',?,'a.js')")
      .run(pr.id)
  );
});
