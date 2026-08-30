// The API agents drive. Deliberately built and testable before any UI exists:
// if two agents can review, argue and triage over these endpoints, the two
// pages are a rendering job rather than a design one.
//
// Identity is a `handle` on every write. Passing `agentId` alongside it
// registers an unknown agent on first use, so a reviewer can bootstrap itself
// without a separate setup call.

import path from 'node:path';

import {
  ensureParticipant,
  getByHandle,
  listParticipants,
} from '../model/participants.js';
import {
  ensureRepo,
  createPull,
  deletePull,
  deleteRepo,
  getPullByNumber,
  getRepo,
  listAllPulls,
  listRepos,
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
import {
  getBlobSha,
  getDefaultBase,
  getHead,
  isSafeRef,
  listBranches,
  resolveBaseRev,
  resolveHeadRev,
  resolveRepoRoot,
} from '../git/gitService.js';
import { pickFolder } from '../fs/pickFolder.js';
import { renderMarkdown } from '../render/markdown.js';
import { reanchorPull } from '../anchor/reanchor.js';

// A thread leaves the API with its bodies already rendered, so a page that
// receives one over the wire (a live update, or a refetch after reconnecting)
// shows the same markdown as the server-rendered page. Without this the client
// falls back to escaping the raw text, and a whole review turns into literal
// asterisks and backticks the moment anything touches it.
const withBodyHtml = (thread) =>
  thread && {
    ...thread,
    comments: (thread.comments || []).map((c) => ({ ...c, bodyHtml: renderMarkdown(c.body) })),
  };

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
  // The repo prequel was started in. Others join it through /api/repos, and a
  // pull request carries the one it belongs to, so nothing below may assume
  // that every PR is about this directory.
  const home = ensureRepo(db, repoRoot);

  const rootOf = (pull) => getRepo(db, pull.repo_id)?.root_path || repoRoot;

  // Accepts any path inside a working copy and answers with its root, so
  // "the folder I was looking at" is enough to add a repo.
  async function gitRoot(input) {
    const root = await resolveRepoRoot(String(input));
    if (!root) bad(`not a git repository: ${input}`);
    return root;
  }

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
    const pull = getPullByNumber(db, n);
    if (!pull) missing(`no PR #${n}`);
    return pull;
  }

  function repoOr404(req) {
    const found = getRepo(db, String(req.params.id));
    if (!found) missing('no such repo');
    return found;
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

  // --- repos -------------------------------------------------------------
  // Everything the new-pull-request picker needs to describe one repo.
  const repoRefs = async (root) => ({
    branches: await listBranches(root),
    head: await getHead(root).catch(() => null),
    defaultBase: await getDefaultBase(root).catch(() => null),
  });

  app.get('/api/repos', handle(async (req, res) => {
    res.json({ repos: listRepos(db).map((r) => ({ ...r, home: r.root_path === repoRoot })) });
  }));

  app.post('/api/repos', handle(async (req, res) => {
    const given = req.body?.path;
    if (!given) bad('path is required');
    const root = await gitRoot(given);
    const added = ensureRepo(db, root);
    emit('repo.added', { repo: added }, req);
    res.json({ repo: added, ...(await repoRefs(root)) });
  }));

  app.get('/api/repos/:id/branches', handle(async (req, res) => {
    res.json(await repoRefs(repoOr404(req).root_path));
  }));

  // Forgetting a repo is only about the list on /pulls: nothing on disk is
  // touched, and a repo still holding pull requests keeps its place.
  app.delete('/api/repos/:id', handle(async (req, res) => {
    const target = repoOr404(req);
    if (target.root_path === repoRoot) bad('prequel is running in this repo');
    if (!deleteRepo(db, target.id)) bad('remove its pull requests first');
    emit('repo.removed', { id: target.id }, req);
    res.json({ ok: true, id: target.id });
  }));

  // Add a repo the way you would open one in any other program: the machine's
  // own folder dialog. A browser cannot tell a page where a folder lives, and
  // the path is the whole point, so the dialog is opened server-side -- which
  // is the same machine, since prequel only ever listens on loopback.
  app.post('/api/repos/pick', handle(async (req, res) => {
    const from = req.body?.repoId ? getRepo(db, String(req.body.repoId)) : null;
    // Open next to a repo you already have: the next one is usually its
    // neighbour rather than somewhere across the disk.
    const near = from?.root_path || repoRoot;
    const picked = await pickFolder({ start: near ? path.dirname(near) : null });
    if (picked?.unavailable) {
      return res.status(501).json({ error: 'this machine has no folder dialog' });
    }
    if (!picked) return res.json({ cancelled: true });
    const added = ensureRepo(db, await gitRoot(picked));
    emit('repo.added', { repo: added }, req);
    res.json({ repo: added, ...(await repoRefs(added.root_path)) });
  }));

  // --- pull requests -----------------------------------------------------
  // Every PR in the store, each carrying the repo it belongs to: one server
  // now shows several repos, and a caller that only wants one can filter on
  // repo_id rather than asking a different server.
  app.get('/api/pulls', handle(async (req, res) => {
    res.json({ repo: home, repos: listRepos(db), pulls: listAllPulls(db) });
  }));

  app.post('/api/pulls', handle(async (req, res) => {
    const b = req.body || {};
    if (!b.title) bad('title is required');
    if (!b.baseRef || !b.headRef) bad('baseRef and headRef are required');
    // A ref beginning with "-" is an option as far as git is concerned, and
    // these are replayed into `git diff` on every tab of the PR. Reject them
    // at the write rather than filtering on each read.
    if (!isSafeRef(b.baseRef) || !isSafeRef(b.headRef)) bad('baseRef and headRef must be refs, not options');
    const author = actor(b);
    // Which repo this PR is about: an id or a path from the picker, or the one
    // prequel is running in when the caller says nothing.
    let target = home;
    if (b.repoId) {
      target = getRepo(db, String(b.repoId));
      if (!target) missing(`unknown repo: ${b.repoId}`);
    } else if (b.repoPath) {
      target = ensureRepo(db, await gitRoot(b.repoPath));
    }
    const pull = createPull(db, {
      repoId: target.id,
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
    if (b.baseRef !== undefined && !isSafeRef(b.baseRef)) bad('baseRef must be a ref, not an option');
    if (b.headRef !== undefined && !isSafeRef(b.headRef)) bad('headRef must be a ref, not an option');
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

  // Removing a pull request from the list is a delete: its reviews, threads
  // and timeline go with it (ON DELETE CASCADE). Nothing in the repo itself
  // is touched -- the branch it was about is still there.
  app.delete('/api/pulls/:number', handle(async (req, res) => {
    const pull = pullOr404(req);
    const removed = deletePull(db, pull.id);
    if (removed) emit('pull.deleted', { id: pull.id, number: pull.number }, req);
    res.json({ ok: removed, number: pull.number });
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
    // submitReview is idempotent; the timeline must be too, or a retried
    // submit posts a second card for a round that was already published.
    const alreadySubmitted = existing.state === 'submitted';
    const review = submitReview(db, req.params.id, { body: b.body, verdict: b.verdict });
    const count = threads.listThreads(db, review.pull_request_id, { reviewId: review.id }).length;
    if (!alreadySubmitted) addEvent(db, {
      pullRequestId: review.pull_request_id,
      participantId: review.participant_id,
      kind: 'review_submitted',
      // The review id, so the conversation feed can render *this* review
      // rather than guessing from the participant -- a second round by the
      // same reviewer is a normal flow, and guessing showed the first one.
      payload: { reviewId: review.id, verdict: review.verdict, threads: count },
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
    res.json({
      threads: threads.listThreads(db, pull.id, filters).map(withBodyHtml),
      links: threads.listLinks(db, pull.id),
    });
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
    // Against the revision the comment is actually about: the working tree for
    // the new side, the diff's old side (the merge base) for the old one.
    // Recording a worktree sha for an old-side thread would mean the
    // "nothing moved" fast path could never hit for it.
    const snapshotRev =
      b.side === 'old'
        ? await resolveBaseRev(rootOf(pull), pull.base_ref, (await resolveHeadRev(rootOf(pull), pull.head_ref)).rev)
        : 'WORKTREE';
    const blobSha =
      b.blobSha ??
      (b.filePath && snapshotRev
        ? await getBlobSha(rootOf(pull), { rev: snapshotRev, path: b.filePath })
        : null);

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
    emit('thread.created', { thread: withBodyHtml(thread) }, req);
    res.json({ thread: withBodyHtml(thread) });
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
    emit('thread.updated', { thread: withBodyHtml(updated) }, req);
    res.json({ thread: withBodyHtml(updated) });
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
      // The actor is whoever made the handoff, not its subject -- recording the
      // assignee as the actor made the notice read "codex assigned ... to
      // codex". The assignee goes in the payload so the timeline keeps saying
      // who it was at the time, rather than re-deriving it from the thread's
      // current owner and rewriting its own history on the next reassignment.
      const by = b.handle ? actor(b) : null;
      addEvent(db, {
        pullRequestId: thread.pull_request_id,
        participantId: by?.id ?? null,
        kind: 'thread_assigned',
        payload: {
          threadId: thread.id,
          assigneeId,
          assignee: b.assignee ? String(b.assignee) : null,
        },
      });
    }
    emit('thread.updated', { thread: withBodyHtml(updated) }, req);
    res.json({ thread: withBodyHtml(updated) });
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
    const root = rootOf(pull);
    // 'HEAD' means "the code this PR is about", which for a branch that is not
    // checked out here is the branch itself rather than this working copy.
    const rev =
      req.body?.rev === 'HEAD' ? (await resolveHeadRev(root, pull.head_ref)).rev : 'WORKTREE';
    const changes = await reanchorPull(db, {
      repoRoot: root,
      pullRequestId: pull.id,
      rev,
      baseRev: await resolveBaseRev(root, pull.base_ref, rev === 'WORKTREE' ? 'HEAD' : rev),
      // What some other revision happens to contain says nothing about the
      // thread; only the tree the threads were written against may rewrite one.
      persist: rev === 'WORKTREE',
    });
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
