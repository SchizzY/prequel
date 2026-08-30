// The API agents drive. Deliberately built and testable before any UI exists:
// if two agents can review, argue and triage over these endpoints, the two
// pages are a rendering job rather than a design one.
//
// Identity is a `handle` on every write. Passing `agentId` alongside it
// registers an unknown agent on first use, so a reviewer can bootstrap itself
// without a separate setup call.

import {
  ensureParticipant,
  getByHandle,
  listParticipants,
} from '../model/participants.js';
import {
  ensureRepo,
  createPull,
  getPullByNumber,
  listPulls,
  updatePull,
  tabCounts,
} from '../model/pulls.js';
import {
  getOrCreatePending,
  submitReview,
  listReviews,
  verdictSummary,
  getReview,
} from '../model/reviews.js';
import * as threads from '../model/threads.js';
import { addEvent, listTimeline } from '../model/timeline.js';
import { getBlobSha } from '../git/gitService.js';
import { reanchorPull } from '../anchor/reanchor.js';

const SEVERITIES = ['blocking', 'suggestion', 'nit', 'question'];
const VERDICTS = ['approve', 'request_changes', 'comment'];

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => {
  throw new ApiError(400, msg);
};
const missing = (msg) => {
  throw new ApiError(404, msg);
};

/** Wrap a handler so thrown ApiErrors become responses instead of crashes. */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};

export function mountApi(app, db, { repoRoot, emit = () => {} } = {}) {
  const repo = ensureRepo(db, repoRoot);

  // Resolve the actor for a write. `agentId` present => register on first use.
  function actor(source) {
    const handleName = source.handle || source.author;
    if (!handleName) bad('handle is required');
    const found = getByHandle(db, handleName);
    if (found) return found;
    if (!source.agentId) missing(`unknown participant: ${handleName}`);
    return ensureParticipant(db, {
      handle: handleName,
      displayName: source.displayName,
      agentId: source.agentId,
    });
  }

  function pullOr404(req) {
    const n = Number(req.params.number);
    if (!Number.isInteger(n)) bad('bad PR number');
    const pull = getPullByNumber(db, repo.id, n);
    if (!pull) missing(`no PR #${n}`);
    return pull;
  }

  function threadOr404(req) {
    const thread = threads.getThread(db, req.params.id);
    if (!thread) missing('no such thread');
    return thread;
  }

  const oneOf = (value, allowed, field) => {
    if (value !== undefined && value !== null && !allowed.includes(value)) {
      bad(`${field} must be one of ${allowed.join(', ')}`);
    }
    return value ?? null;
  };

  // --- participants ------------------------------------------------------
  app.get('/api/participants', handle(async (req, res) => {
    res.json({ participants: listParticipants(db) });
  }));

  app.post('/api/participants', handle(async (req, res) => {
    const { handle: h, displayName, agentId } = req.body || {};
    if (!h) bad('handle is required');
    res.json({ participant: ensureParticipant(db, { handle: h, displayName, agentId }) });
  }));

  // --- pull requests -----------------------------------------------------
  app.get('/api/pulls', handle(async (req, res) => {
    res.json({ repo, pulls: listPulls(db, repo.id) });
  }));

  app.post('/api/pulls', handle(async (req, res) => {
    const b = req.body || {};
    if (!b.title) bad('title is required');
    if (!b.baseRef || !b.headRef) bad('baseRef and headRef are required');
    const author = actor(b);
    const pull = createPull(db, {
      repoId: repo.id,
      title: b.title,
      body: b.body,
      authorId: author.id,
      baseRef: b.baseRef,
      headRef: b.headRef,
      baseSha: b.baseSha,
      headSha: b.headSha,
      diffMode: b.diffMode,
      worktreePath: b.worktreePath,
    });
    addEvent(db, { pullRequestId: pull.id, participantId: author.id, kind: 'opened' });
    emit('pull.created', { pull }, req);
    res.json({ pull });
  }));

  app.get('/api/pulls/:number', handle(async (req, res) => {
    const pull = pullOr404(req);
    res.json({
      pull,
      counts: tabCounts(db, pull.id),
      reviews: listReviews(db, pull.id, { state: 'submitted' }),
      verdicts: verdictSummary(db, pull.id),
    });
  }));

  app.patch('/api/pulls/:number', handle(async (req, res) => {
    const pull = pullOr404(req);
    const b = req.body || {};
    oneOf(b.state, ['draft', 'open', 'merged', 'closed'], 'state');
    const updated = updatePull(db, pull.id, b);
    if (b.state && b.state !== pull.state) {
      addEvent(db, {
        pullRequestId: pull.id,
        participantId: b.handle ? actor(b).id : null,
        kind: b.state === 'closed' ? 'closed' : 'reopened',
      });
    }
    emit('pull.updated', { pull: updated }, req);
    res.json({ pull: updated });
  }));

  app.get('/api/pulls/:number/timeline', handle(async (req, res) => {
    res.json({ timeline: listTimeline(db, pullOr404(req).id) });
  }));

  // --- reviews -----------------------------------------------------------
  app.get('/api/pulls/:number/reviews', handle(async (req, res) => {
    const pull = pullOr404(req);
    const state = oneOf(req.query.state, ['pending', 'submitted'], 'state');
    res.json({ reviews: listReviews(db, pull.id, { state: state || undefined }) });
  }));

  // Open (or recover) this reviewer's draft.
  app.post('/api/pulls/:number/reviews', handle(async (req, res) => {
    const pull = pullOr404(req);
    const who = actor(req.body || {});
    const review = getOrCreatePending(db, {
      pullRequestId: pull.id,
      participantId: who.id,
      headSha: req.body?.headSha ?? pull.head_sha,
    });
    res.json({ review });
  }));

  app.post('/api/reviews/:id/submit', handle(async (req, res) => {
    const b = req.body || {};
    const existing = getReview(db, req.params.id);
    if (!existing) missing('no such review');
    if (!b.verdict) bad('verdict is required');
    oneOf(b.verdict, VERDICTS, 'verdict');
    const review = submitReview(db, req.params.id, { body: b.body, verdict: b.verdict });
    const count = threads.listThreads(db, review.pull_request_id, { reviewId: review.id }).length;
    addEvent(db, {
      pullRequestId: review.pull_request_id,
      participantId: review.participant_id,
      kind: 'review_submitted',
      payload: { verdict: review.verdict, threads: count },
    });
    emit('review.submitted', { review }, req);
    res.json({ review, threads: count });
  }));

  // --- threads -----------------------------------------------------------
  app.get('/api/pulls/:number/threads', handle(async (req, res) => {
    const pull = pullOr404(req);
    const q = req.query;
    const filters = {
      status: oneOf(q.status, ['open', 'resolved'], 'status') || undefined,
      filePath: q.file || undefined,
      reviewId: q.reviewId || undefined,
      severity: q.severity ? String(q.severity).split(',') : undefined,
    };
    // ?anchored=1 -> Files changed tab, ?anchored=0 -> Conversation tab
    if (q.anchored === '1') filters.anchored = true;
    if (q.anchored === '0') filters.anchored = false;
    if (q.assignee) {
      const p = getByHandle(db, String(q.assignee));
      if (!p) missing(`unknown participant: ${q.assignee}`);
      filters.assigneeId = p.id;
    }
    res.json({ threads: threads.listThreads(db, pull.id, filters), links: threads.listLinks(db, pull.id) });
  }));

  app.post('/api/pulls/:number/threads', handle(async (req, res) => {
    const pull = pullOr404(req);
    const b = req.body || {};
    if (!b.body) bad('body is required');
    const who = actor(b);
    oneOf(b.severity, SEVERITIES, 'severity');
    oneOf(b.side, ['old', 'new', 'file'], 'side');

    let assigneeId = null;
    if (b.assignee) {
      const p = getByHandle(db, String(b.assignee));
      if (!p) missing(`unknown assignee: ${b.assignee}`);
      assigneeId = p.id;
    }
    // Record which version of the file this was written against, so
    // re-anchoring can tell "nothing moved" from "not checked yet" without
    // rescanning every file on every pass.
    const blobSha =
      b.blobSha ??
      (b.filePath ? await getBlobSha(repoRoot, { rev: 'WORKTREE', path: b.filePath }) : null);

    const thread = threads.createThread(db, {
      pullRequestId: pull.id,
      participantId: who.id,
      reviewId: b.reviewId ?? null,
      filePath: b.filePath ?? null,
      side: b.side,
      startLine: b.startLine,
      endLine: b.endLine,
      blobSha,
      lineSnapshot: b.lineSnapshot,
      severity: b.severity,
      category: b.category,
      assigneeId,
      body: b.body,
    });
    // A conversation-level thread with no review behind it is a plain comment
    // on the PR; that belongs in the timeline.
    if (!thread.file_path && !b.reviewId) {
      addEvent(db, { pullRequestId: pull.id, participantId: who.id, kind: 'commented', payload: { threadId: thread.id } });
    }
    emit('thread.created', { thread }, req);
    res.json({ thread });
  }));

  app.post('/api/threads/:id/comments', handle(async (req, res) => {
    const thread = threadOr404(req);
    const b = req.body || {};
    if (!b.body) bad('body is required');
    const who = actor(b);
    threads.addComment(db, {
      threadId: thread.id,
      participantId: who.id,
      body: b.body,
      reviewId: b.reviewId ?? null,
    });
    const updated = threads.getThread(db, thread.id);
    emit('thread.updated', { thread: updated }, req);
    res.json({ thread: updated });
  }));

  app.patch('/api/threads/:id', handle(async (req, res) => {
    const thread = threadOr404(req);
    const b = req.body || {};
    let updated = thread;

    if (b.status) {
      oneOf(b.status, ['open', 'resolved'], 'status');
      const by = b.handle ? actor(b) : null;
      updated = threads.setStatus(db, thread.id, b.status, by?.id ?? null);
      if (b.status === 'resolved') {
        addEvent(db, {
          pullRequestId: thread.pull_request_id,
          participantId: by?.id ?? null,
          kind: 'thread_resolved',
          payload: { threadId: thread.id },
        });
      }
    }
    if (b.severity !== undefined) {
      oneOf(b.severity, SEVERITIES, 'severity');
      updated = threads.setSeverity(db, thread.id, b.severity, b.category);
    }
    if (b.anchorState) {
      oneOf(b.anchorState, ['current', 'outdated', 'lost'], 'anchorState');
      updated = threads.setAnchorState(db, thread.id, b.anchorState);
    }
    if (b.assignee !== undefined) {
      let assigneeId = null;
      if (b.assignee) {
        const p = getByHandle(db, String(b.assignee));
        if (!p) missing(`unknown assignee: ${b.assignee}`);
        assigneeId = p.id;
      }
      updated = threads.assign(db, thread.id, assigneeId);
      addEvent(db, {
        pullRequestId: thread.pull_request_id,
        participantId: assigneeId,
        kind: 'thread_assigned',
        payload: { threadId: thread.id },
      });
    }
    emit('thread.updated', { thread: updated }, req);
    res.json({ thread: updated });
  }));

  // Triage: record that two reviewers found the same thing, or disagree.
  app.post('/api/threads/:id/links', handle(async (req, res) => {
    const thread = threadOr404(req);
    const b = req.body || {};
    oneOf(b.kind, ['duplicate_of', 'related_to', 'contradicts'], 'kind');
    if (!b.toThreadId) bad('toThreadId is required');
    if (!threads.getThread(db, b.toThreadId)) missing('no such target thread');
    const by = b.handle ? actor(b) : null;
    threads.linkThreads(db, thread.id, b.toThreadId, b.kind, by?.id ?? null);
    addEvent(db, {
      pullRequestId: thread.pull_request_id,
      participantId: by?.id ?? null,
      kind: 'triaged',
      payload: { from: thread.id, to: b.toThreadId, kind: b.kind },
    });
    res.json({ ok: true });
  }));

  // Re-point every thread at the code it was written about. Worth calling
  // after an agent finishes editing, so the next reviewer is not handed line
  // numbers that drifted underneath it.
  app.post('/api/pulls/:number/reanchor', handle(async (req, res) => {
    const pull = pullOr404(req);
    const rev = req.body?.rev === 'HEAD' ? 'HEAD' : 'WORKTREE';
    const changes = await reanchorPull(db, { repoRoot, pullRequestId: pull.id, rev });
    for (const change of changes) emit('thread.reanchored', { change }, req);
    res.json({
      changed: changes.length,
      moved: changes.filter((c) => c.moved).length,
      lost: changes.filter((c) => c.anchorState === 'lost').length,
      outdated: changes.filter((c) => c.anchorState === 'outdated').length,
      changes,
    });
  }));

  // --- the agent work queue ---------------------------------------------
  // Replaces `?author=user`, which cannot tell two agents apart.
  app.get('/api/pulls/:number/queue', handle(async (req, res) => {
    const pull = pullOr404(req);
    const who = getByHandle(db, String(req.query.handle || ''));
    if (!who) missing(`unknown participant: ${req.query.handle}`);
    res.json({
      queue: threads.workQueue(db, {
        pullRequestId: pull.id,
        participantId: who.id,
        severity: req.query.severity ? String(req.query.severity).split(',') : undefined,
      }),
    });
  }));

  // --- mention inbox: how agent B learns agent A replied -----------------
  app.get('/api/inbox', handle(async (req, res) => {
    const who = getByHandle(db, String(req.query.handle || ''));
    if (!who) missing(`unknown participant: ${req.query.handle}`);
    res.json({ mentions: threads.inbox(db, who.id) });
  }));

  app.post('/api/inbox/seen', handle(async (req, res) => {
    const who = actor(req.body || {});
    res.json({ marked: threads.markMentionsSeen(db, who.id) });
  }));

  return app;
}
