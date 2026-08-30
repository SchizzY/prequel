// Drives the whole multi-reviewer flow over HTTP, with no UI involved:
// two agents review the same PR, one is assigned the other's finding, they
// argue in a thread, a triage pass dedupes them, and the work gets resolved.
//
// If this passes, the two pages are a rendering job.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../src/server.js';

let base;
let server;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-api-'));
  const app = createServer({ repoRoot: dir, dbPath: path.join(dir, 'prequel.db') });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

const GET = (u) => api('GET', u);
const POST = (u, b) => api('POST', u, b);
const PATCH = (u, b) => api('PATCH', u, b);

// Shared across the ordered scenario below.
const ctx = {};

test('agents register themselves on first use', async () => {
  const human = await POST('/api/participants', { handle: 'cahill', displayName: 'Cahill' });
  assert.equal(human.participant.kind, 'human');

  // an agent bootstraps by passing agentId alongside its handle
  const claude = await POST('/api/participants', { handle: 'claude', agentId: 'claude-code' });
  const codex = await POST('/api/participants', { handle: 'codex', agentId: 'codex' });
  assert.equal(claude.participant.kind, 'agent');
  assert.equal(codex.participant.agent_id, 'codex');

  const all = await GET('/api/participants');
  assert.equal(all.participants.length, 3);
});

test('opening a PR records it on the timeline', async () => {
  const { pull, status } = await POST('/api/pulls', {
    handle: 'cahill',
    title: 'Add SQLite store',
    body: 'Replaces the JSON comment store.',
    baseRef: 'main',
    headRef: 'multi-reviewer',
  });
  assert.equal(status, 200);
  assert.equal(pull.number, 1);
  ctx.pr = pull.number;

  const { timeline } = await GET(`/api/pulls/${ctx.pr}/timeline`);
  assert.deepEqual(timeline.map((e) => e.kind), ['opened']);
  assert.equal(timeline[0].handle, 'cahill');
});

test('two agents hold independent draft reviews', async () => {
  const claude = await POST(`/api/pulls/${ctx.pr}/reviews`, { handle: 'claude' });
  const codex = await POST(`/api/pulls/${ctx.pr}/reviews`, { handle: 'codex' });
  assert.notEqual(claude.review.id, codex.review.id);
  assert.equal(claude.review.state, 'pending');

  // idempotent: an agent resuming its run gets the same draft back
  const again = await POST(`/api/pulls/${ctx.pr}/reviews`, { handle: 'claude' });
  assert.equal(again.review.id, claude.review.id);

  ctx.claudeReview = claude.review.id;
  ctx.codexReview = codex.review.id;
});

test('reviewers file findings against their own draft', async () => {
  const a = await POST(`/api/pulls/${ctx.pr}/threads`, {
    handle: 'claude',
    reviewId: ctx.claudeReview,
    filePath: 'src/db/index.js',
    side: 'new',
    startLine: 42,
    severity: 'blocking',
    category: 'correctness',
    lineSnapshot: ["  db.exec('BEGIN');"],
    body: 'Deferred transaction; needs BEGIN IMMEDIATE.',
  });
  assert.equal(a.thread.severity, 'blocking');
  assert.deepEqual(a.thread.line_snapshot, ["  db.exec('BEGIN');"]);
  assert.equal(a.thread.comments.length, 1);
  ctx.claudeThread = a.thread.id;

  // Codex independently finds the same thing
  const b = await POST(`/api/pulls/${ctx.pr}/threads`, {
    handle: 'codex',
    reviewId: ctx.codexReview,
    filePath: 'src/db/index.js',
    side: 'new',
    startLine: 42,
    severity: 'blocking',
    body: 'Two writers can read the same MAX(seq).',
  });
  ctx.codexThread = b.thread.id;

  await POST(`/api/pulls/${ctx.pr}/threads`, {
    handle: 'codex',
    reviewId: ctx.codexReview,
    filePath: 'src/model/pulls.js',
    startLine: 7,
    severity: 'nit',
    body: 'Call it nextNumber.',
  });
});

test('submitting a review attributes its findings and verdict', async () => {
  const claude = await POST(`/api/reviews/${ctx.claudeReview}/submit`, {
    body: 'One blocking issue in the tx helper.',
    verdict: 'request_changes',
  });
  assert.equal(claude.review.state, 'submitted');
  assert.equal(claude.threads, 1);

  const codex = await POST(`/api/reviews/${ctx.codexReview}/submit`, {
    body: 'Same tx issue, plus a nit.',
    verdict: 'request_changes',
  });
  assert.equal(codex.threads, 2);

  const { verdicts, reviews } = await GET(`/api/pulls/${ctx.pr}`);
  assert.equal(reviews.length, 2);
  assert.deepEqual(verdicts.map((v) => v.handle).sort(), ['claude', 'codex']);
  assert.ok(verdicts.every((v) => v.verdict === 'request_changes'));

  const { timeline } = await GET(`/api/pulls/${ctx.pr}/timeline`);
  assert.deepEqual(timeline.map((e) => e.kind), ['opened', 'review_submitted', 'review_submitted']);
});

test('a bad verdict is rejected, not coerced', async () => {
  const res = await POST(`/api/reviews/${ctx.claudeReview}/submit`, { verdict: 'lgtm' });
  assert.equal(res.status, 400);
  assert.match(res.error, /verdict must be one of/);
});

test('triage dedupes across reviewers', async () => {
  const res = await POST(`/api/threads/${ctx.codexThread}/links`, {
    handle: 'cahill',
    toThreadId: ctx.claudeThread,
    kind: 'duplicate_of',
  });
  assert.equal(res.status, 200);

  const { links } = await GET(`/api/pulls/${ctx.pr}/threads`);
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, 'duplicate_of');
  assert.equal(links[0].to_thread_id, ctx.claudeThread);
});

test('assignment routes work to a specific agent', async () => {
  // Claude found it; Codex is asked to fix it. The old author-based queue had
  // no way to express this.
  await PATCH(`/api/threads/${ctx.claudeThread}`, { assignee: 'codex' });

  const codexQueue = await GET(`/api/pulls/${ctx.pr}/queue?handle=codex`);
  assert.ok(codexQueue.queue.some((t) => t.id === ctx.claudeThread));
  // blocking sorts ahead of the nit
  assert.equal(codexQueue.queue[0].severity, 'blocking');

  const claudeQueue = await GET(`/api/pulls/${ctx.pr}/queue?handle=claude`);
  assert.ok(
    !claudeQueue.queue.some((t) => t.id === ctx.claudeThread),
    'assigned away, so not in the finder queue'
  );

  const urgent = await GET(`/api/pulls/${ctx.pr}/queue?handle=codex&severity=blocking`);
  assert.ok(urgent.queue.every((t) => t.severity === 'blocking'));
});

test('agents hold a conversation in a thread and mentions reach the inbox', async () => {
  await POST(`/api/threads/${ctx.claudeThread}/comments`, {
    handle: 'codex',
    body: 'Disagree @claude - WAL already serialises writers.',
  });
  await POST(`/api/threads/${ctx.claudeThread}/comments`, {
    handle: 'claude',
    body: '@codex not for read-then-write; see the MAX(seq) select.',
  });
  const third = await POST(`/api/threads/${ctx.claudeThread}/comments`, {
    handle: 'codex',
    body: 'Fair. Taking IMMEDIATE.',
  });
  // four deep: the original store refused anything past a single reply
  assert.equal(third.thread.comments.length, 4);
  assert.deepEqual(
    third.thread.comments.map((c) => c.handle),
    ['claude', 'codex', 'claude', 'codex']
  );

  const inbox = await GET('/api/inbox?handle=claude');
  assert.equal(inbox.mentions.length, 1);
  assert.equal(inbox.mentions[0].from_handle, 'codex');

  const seen = await POST('/api/inbox/seen', { handle: 'claude' });
  assert.equal(seen.marked, 1);
  assert.equal((await GET('/api/inbox?handle=claude')).mentions.length, 0);
});

test('resolving clears the queue and lands on the timeline', async () => {
  const before = await GET(`/api/pulls/${ctx.pr}/queue?handle=codex`);
  await PATCH(`/api/threads/${ctx.claudeThread}`, { status: 'resolved', handle: 'codex' });
  const after = await GET(`/api/pulls/${ctx.pr}/queue?handle=codex`);
  assert.equal(after.queue.length, before.queue.length - 1);

  const { threads } = await GET(`/api/pulls/${ctx.pr}/threads?status=resolved`);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, ctx.claudeThread);

  const { timeline } = await GET(`/api/pulls/${ctx.pr}/timeline`);
  assert.ok(timeline.some((e) => e.kind === 'thread_resolved' && e.handle === 'codex'));
});

test('the two tabs are separable by one query parameter', async () => {
  await POST(`/api/pulls/${ctx.pr}/threads`, {
    handle: 'cahill',
    body: 'Overall direction looks right to me.',
  });

  const conversation = await GET(`/api/pulls/${ctx.pr}/threads?anchored=0`);
  assert.equal(conversation.threads.length, 1);
  assert.equal(conversation.threads[0].file_path, null);

  const files = await GET(`/api/pulls/${ctx.pr}/threads?anchored=1`);
  assert.equal(files.threads.length, 3);
  assert.ok(files.threads.every((t) => t.file_path));

  const { counts } = await GET(`/api/pulls/${ctx.pr}`);
  assert.equal(counts.conversation, 1);
  assert.equal(counts.files, 3);

  // a plain PR-level comment is part of the story
  const { timeline } = await GET(`/api/pulls/${ctx.pr}/timeline`);
  assert.ok(timeline.some((e) => e.kind === 'commented' && e.handle === 'cahill'));
});

test('unknown handles and PRs are errors, not silent coercion', async () => {
  // the original server quietly turned any unknown author into "user"
  const bogus = await POST(`/api/pulls/${ctx.pr}/threads`, { handle: 'nobody', body: 'hi' });
  assert.equal(bogus.status, 404);

  const noPr = await GET('/api/pulls/999');
  assert.equal(noPr.status, 404);

  const noHandle = await POST(`/api/pulls/${ctx.pr}/threads`, { body: 'hi' });
  assert.equal(noHandle.status, 400);

  const badSeverity = await POST(`/api/pulls/${ctx.pr}/threads`, {
    handle: 'cahill',
    body: 'hi',
    severity: 'catastrophic',
  });
  assert.equal(badSeverity.status, 400);
});

test('the original single-agent API still works alongside the new one', async () => {
  const res = await fetch(`${base}/api/comments`);
  assert.equal(res.status, 200);
  const { comments } = await res.json();
  assert.ok(Array.isArray(comments));

  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.app, 'prequel');
});
