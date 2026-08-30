// A review is one reviewer's round: a narrative body, a verdict, and the
// threads they opened while it was pending. This is the structure that keeps
// forty findings from reading as forty unrelated interruptions -- the body
// carries the thesis, the threads carry the specifics.

import { newId, plain, plainAll, tx } from '../db/index.js';

/**
 * A reviewer has at most one pending review per PR (enforced by the partial
 * unique index), so this is the natural entry point: an agent starting work
 * calls it without needing to track whether it already has a draft open.
 */
export function getOrCreatePending(db, { pullRequestId, participantId, headSha = null }) {
  return tx(db, () => {
    const found = db
      .prepare(
        "SELECT * FROM review WHERE pull_request_id = ? AND participant_id = ? AND state = 'pending'"
      )
      .get(pullRequestId, participantId);
    if (found) return plain(found);
    const id = newId();
    db.prepare(
      'INSERT INTO review (id, pull_request_id, participant_id, head_sha) VALUES (?, ?, ?, ?)'
    ).run(id, pullRequestId, participantId, headSha);
    return plain(db.prepare('SELECT * FROM review WHERE id = ?').get(id));
  });
}

export function getReview(db, id) {
  return plain(db.prepare('SELECT * FROM review WHERE id = ?').get(id));
}

/**
 * Publish a pending review. Until this runs, its threads are drafts -- the
 * equivalent of GitHub holding your inline comments back until you hit
 * "Submit review".
 */
export function submitReview(db, id, { body, verdict }) {
  const review = getReview(db, id);
  if (!review) return null;
  if (review.state === 'submitted') return review;
  db.prepare(
    `UPDATE review
     SET body = COALESCE(?, body), verdict = ?, state = 'submitted',
         submitted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).run(body ?? null, verdict, id);
  return getReview(db, id);
}

export function listReviews(db, pullRequestId, { state } = {}) {
  const where = ['r.pull_request_id = ?'];
  const values = [pullRequestId];
  if (state) {
    where.push('r.state = ?');
    values.push(state);
  }
  return plainAll(
    db
      .prepare(
        `SELECT r.*, p.handle, p.display_name, p.kind, p.color,
                (SELECT COUNT(DISTINCT c.thread_id) FROM comment c WHERE c.review_id = r.id)
                  AS thread_count
         FROM review r
         JOIN participant p ON p.id = r.participant_id
         WHERE ${where.join(' AND ')}
         ORDER BY COALESCE(r.submitted_at, r.created_at)`
      )
      .all(...values)
  );
}

/** Verdict per reviewer, for the PR header ("2 approvals, 1 requesting changes"). */
export function verdictSummary(db, pullRequestId) {
  return plainAll(
    db
      .prepare(
        `SELECT p.handle, p.kind, r.verdict, r.submitted_at
         FROM review r
         JOIN participant p ON p.id = r.participant_id
         WHERE r.pull_request_id = ? AND r.state = 'submitted'
           AND r.id = (SELECT r2.id FROM review r2
                       WHERE r2.participant_id = r.participant_id
                         AND r2.pull_request_id = r.pull_request_id
                         AND r2.state = 'submitted'
                       ORDER BY r2.submitted_at DESC LIMIT 1)
         ORDER BY p.handle`
      )
      .all(pullRequestId)
  );
}
