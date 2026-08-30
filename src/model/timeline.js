// The Conversation tab feed. Everything that happens to a PR lands here so the
// tab can render one chronological story instead of stitching several tables
// together at read time.

import { newId, plain, plainAll } from '../db/index.js';

export const EVENT_KINDS = [
  'opened',
  'closed',
  'reopened',
  'commented',
  'review_submitted',
  'commits_added',
  'thread_resolved',
  'thread_assigned',
  'triaged',
];

export function addEvent(db, { pullRequestId, participantId = null, kind, payload = null }) {
  const id = newId();
  db.prepare(
    'INSERT INTO timeline_event (id, pull_request_id, participant_id, kind, payload) VALUES (?, ?, ?, ?, ?)'
  ).run(id, pullRequestId, participantId, kind, payload ? JSON.stringify(payload) : null);
  return plain(db.prepare('SELECT * FROM timeline_event WHERE id = ?').get(id));
}

export function listTimeline(db, pullRequestId) {
  const rows = plainAll(
    db
      .prepare(
        `SELECT e.*, p.handle, p.display_name, p.kind AS participant_kind, p.color
         FROM timeline_event e
         LEFT JOIN participant p ON p.id = e.participant_id
         WHERE e.pull_request_id = ?
         ORDER BY e.created_at, e.rowid`
      )
      .all(pullRequestId)
  );
  return rows.map((e) => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null }));
}
