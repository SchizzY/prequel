// A thread owns the anchor and the lifecycle; comments are just the messages
// on it. Splitting them is what allows arbitrarily deep replies (the old store
// rejected replies-to-replies because the anchor lived on the root comment)
// and gives severity, assignment and anchor drift exactly one home.

import { newId, plain, plainAll, tx } from '../db/index.js';

// @handle, not preceded by a word character so emails do not match. `.` and
// `-` are legal inside a handle but not at the end of one, so that the common
// "over to you @claude." reads as a mention of `claude` rather than of
// `claude.`, which matches no participant and delivers nothing.
const MENTION_RE = /(?<![\w@])@([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)/gi;

function recordMentions(db, commentId, body) {
  const handles = [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase()))];
  if (!handles.length) return;
  const find = db.prepare('SELECT id FROM participant WHERE lower(handle) = ?');
  const add = db.prepare(
    'INSERT OR IGNORE INTO mention (comment_id, participant_id) VALUES (?, ?)'
  );
  for (const handle of handles) {
    const row = find.get(handle);
    if (row) add.run(commentId, row.id);
  }
}

function insertComment(db, { threadId, participantId, body, reviewId = null, legacyId = null }) {
  // seq is allocated read-then-write; tx() holds the write lock so two agents
  // replying at once serialise instead of colliding. UNIQUE(thread_id, seq) is
  // the backstop if that ever fails.
  const { next } = db
    .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM comment WHERE thread_id = ?')
    .get(threadId);
  const id = newId();
  db.prepare(
    `INSERT INTO comment (id, thread_id, review_id, participant_id, body, seq, legacy_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, threadId, reviewId, participantId, body, next, legacyId);
  recordMentions(db, id, body);
  db.prepare(
    "UPDATE thread SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(threadId);
  return plain(db.prepare('SELECT * FROM comment WHERE id = ?').get(id));
}

/**
 * Create a thread and its opening comment atomically.
 * Omit filePath/side for a conversation-level (PR-wide) thread.
 */
export function createThread(db, data) {
  return tx(db, () => {
    const id = newId();
    const anchored = Boolean(data.filePath);
    db.prepare(
      `INSERT INTO thread
         (id, pull_request_id, file_path, side, start_line, end_line, blob_sha,
          line_snapshot, severity, category, assignee_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.pullRequestId,
      anchored ? data.filePath : null,
      anchored ? (data.side ?? 'new') : null,
      anchored ? (data.startLine ?? null) : null,
      anchored ? (data.endLine ?? data.startLine ?? null) : null,
      data.blobSha ?? null,
      data.lineSnapshot ? JSON.stringify(data.lineSnapshot) : null,
      data.severity ?? null,
      data.category ?? null,
      data.assigneeId ?? null
    );
    insertComment(db, {
      threadId: id,
      participantId: data.participantId,
      body: data.body,
      reviewId: data.reviewId ?? null,
      legacyId: data.legacyId ?? null,
    });
    return getThread(db, id);
  });
}

export function addComment(db, data) {
  return tx(db, () => insertComment(db, data));
}

export function getThread(db, id) {
  const thread = plain(db.prepare('SELECT * FROM thread WHERE id = ?').get(id));
  if (!thread) return null;
  return hydrate(db, [thread])[0];
}

function hydrate(db, threads) {
  if (!threads.length) return [];
  const ids = threads.map((t) => t.id);
  const placeholders = ids.map(() => '?').join(',');
  const comments = plainAll(
    db
      .prepare(
        `SELECT c.*, p.handle, p.display_name, p.kind, p.color
         FROM comment c JOIN participant p ON p.id = c.participant_id
         WHERE c.thread_id IN (${placeholders}) AND c.deleted_at IS NULL
         ORDER BY c.thread_id, c.seq`
      )
      .all(...ids)
  );
  const byThread = new Map(ids.map((id) => [id, []]));
  for (const c of comments) byThread.get(c.thread_id)?.push(c);
  return threads.map((t) => ({
    ...t,
    line_snapshot: t.line_snapshot ? JSON.parse(t.line_snapshot) : null,
    comments: byThread.get(t.id) ?? [],
  }));
}

/**
 * Filters: status, severity (array), assigneeId, filePath, anchored (bool),
 * reviewId, authorId. Omit all to get everything.
 */
export function listThreads(db, pullRequestId, filters = {}) {
  const where = ['t.pull_request_id = ?'];
  const values = [pullRequestId];
  if (filters.status) {
    where.push('t.status = ?');
    values.push(filters.status);
  }
  if (filters.severity?.length) {
    where.push(`t.severity IN (${filters.severity.map(() => '?').join(',')})`);
    values.push(...filters.severity);
  }
  if (filters.assigneeId) {
    where.push('t.assignee_id = ?');
    values.push(filters.assigneeId);
  }
  if (filters.filePath) {
    where.push('t.file_path = ?');
    values.push(filters.filePath);
  }
  if (filters.anchored === true) where.push('t.file_path IS NOT NULL');
  if (filters.anchored === false) where.push('t.file_path IS NULL');
  if (filters.reviewId) {
    where.push('EXISTS (SELECT 1 FROM comment c WHERE c.thread_id = t.id AND c.review_id = ?)');
    values.push(filters.reviewId);
  }
  if (filters.authorId) {
    where.push(
      'EXISTS (SELECT 1 FROM comment c WHERE c.thread_id = t.id AND c.participant_id = ?)'
    );
    values.push(filters.authorId);
  }
  const rows = plainAll(
    db
      .prepare(
        `SELECT t.* FROM thread t WHERE ${where.join(' AND ')}
         ORDER BY t.file_path IS NULL DESC, t.file_path, t.start_line, t.created_at`
      )
      .all(...values)
  );
  return hydrate(db, rows);
}

/**
 * An agent's work queue. This replaces "comments whose author is the human",
 * which cannot tell two agents apart.
 * Unassigned threads are included: they are up for grabs.
 */
export function workQueue(db, { pullRequestId, participantId, severity }) {
  const where = [
    't.pull_request_id = ?',
    "t.status = 'open'",
    "t.anchor_state <> 'lost'",
    '(t.assignee_id = ? OR t.assignee_id IS NULL)',
  ];
  const values = [pullRequestId, participantId];
  if (severity?.length) {
    where.push(`t.severity IN (${severity.map(() => '?').join(',')})`);
    values.push(...severity);
  }
  const rows = plainAll(
    db
      .prepare(
        `SELECT t.* FROM thread t
         WHERE ${where.join(' AND ')}
         ORDER BY CASE t.severity
                    WHEN 'blocking'   THEN 0
                    WHEN 'suggestion' THEN 1
                    WHEN 'question'   THEN 2
                    WHEN 'nit'        THEN 3
                    ELSE 4 END,
                  t.file_path, t.start_line`
      )
      .all(...values)
  );
  return hydrate(db, rows);
}

export function setStatus(db, id, status, resolvedById = null) {
  db.prepare(
    `UPDATE thread
     SET status = ?,
         resolved_by_id = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END,
         resolved_at = CASE WHEN ? = 'resolved'
                            THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).run(status, status, resolvedById, status, id);
  return getThread(db, id);
}

export function assign(db, id, assigneeId) {
  db.prepare(
    "UPDATE thread SET assignee_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(assigneeId, id);
  return getThread(db, id);
}

export function setAnchorState(db, id, anchorState) {
  db.prepare(
    "UPDATE thread SET anchor_state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(anchorState, id);
  return getThread(db, id);
}

export function setSeverity(db, id, severity, category = undefined) {
  db.prepare(
    `UPDATE thread SET severity = ?,
       category = COALESCE(?, category),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).run(severity, category ?? null, id);
  return getThread(db, id);
}

/** How the triage pass records dedup and disagreement across reviewers. */
export function linkThreads(db, fromId, toId, kind, createdById = null) {
  db.prepare(
    `INSERT OR IGNORE INTO thread_link (from_thread_id, to_thread_id, kind, created_by_id)
     VALUES (?, ?, ?, ?)`
  ).run(fromId, toId, kind, createdById);
}

export function listLinks(db, pullRequestId) {
  return plainAll(
    db
      .prepare(
        `SELECT l.* FROM thread_link l
         JOIN thread t ON t.id = l.from_thread_id
         WHERE t.pull_request_id = ?`
      )
      .all(pullRequestId)
  );
}

/** Unseen @mentions for one participant: how agent B learns agent A replied. */
export function inbox(db, participantId) {
  return plainAll(
    db
      .prepare(
        `SELECT m.comment_id, c.thread_id, c.body, c.created_at, p.handle AS from_handle
         FROM mention m
         JOIN comment c ON c.id = m.comment_id
         JOIN participant p ON p.id = c.participant_id
         WHERE m.participant_id = ? AND m.seen_at IS NULL
         ORDER BY c.created_at`
      )
      .all(participantId)
  );
}

export function markMentionsSeen(db, participantId) {
  return db
    .prepare(
      "UPDATE mention SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE participant_id = ? AND seen_at IS NULL"
    )
    .run(participantId).changes;
}

/** The thread an imported legacy comment landed on, if it was imported. */
export function threadForLegacyId(db, legacyId) {
  const row = db.prepare('SELECT thread_id FROM comment WHERE legacy_id = ?').get(legacyId);
  return row ? row.thread_id : null;
}

export function importedLegacyIds(db, repoId) {
  return new Set(
    db
      .prepare(
        `SELECT c.legacy_id FROM comment c
         JOIN thread t ON t.id = c.thread_id
         JOIN pull_request pr ON pr.id = t.pull_request_id
         WHERE pr.repo_id = ? AND c.legacy_id IS NOT NULL`
      )
      .all(repoId)
      .map((r) => r.legacy_id)
  );
}

/**
 * Move a thread's anchor after the code underneath it changed.
 * Separate from setAnchorState because relocating is one atomic fact: where it
 * now points, how confident we are, and the file version we decided against.
 */
export function updateAnchor(db, id, { startLine, endLine, anchorState, blobSha }) {
  db.prepare(
    `UPDATE thread
     SET start_line = ?, end_line = ?, anchor_state = ?,
         blob_sha = COALESCE(?, blob_sha),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).run(startLine, endLine, anchorState, blobSha ?? null, id);
  return getThread(db, id);
}
