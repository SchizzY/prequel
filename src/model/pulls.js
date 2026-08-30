// The PR object the original tool had no room for: the thing a description,
// a conversation and several reviews all hang off.

import { newId, plain, plainAll, tx } from '../db/index.js';

export function ensureRepo(db, rootPath, name = null) {
  const found = plain(db.prepare('SELECT * FROM repo WHERE root_path = ?').get(rootPath));
  if (found) return found;
  const id = newId();
  db.prepare('INSERT INTO repo (id, root_path, name) VALUES (?, ?, ?)').run(
    id,
    rootPath,
    name || rootPath.split(/[\/]/).filter(Boolean).pop() || rootPath
  );
  return plain(db.prepare('SELECT * FROM repo WHERE id = ?').get(id));
}

export function createPull(db, data) {
  return tx(db, () => {
    // Per-repo numbering, so PRs read as #1, #2 like GitHub. Safe under
    // concurrency because tx() holds the write lock across the read.
    const { next } = db
      .prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM pull_request WHERE repo_id = ?')
      .get(data.repoId);
    const id = newId();
    db.prepare(
      `INSERT INTO pull_request
         (id, repo_id, number, title, body, author_id, base_ref, head_ref,
          base_sha, head_sha, diff_mode, worktree_path, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      data.repoId,
      next,
      data.title,
      data.body ?? '',
      data.authorId,
      data.baseRef,
      data.headRef,
      data.baseSha ?? null,
      data.headSha ?? null,
      data.diffMode ?? 'branch',
      data.worktreePath ?? null,
      data.state ?? 'open'
    );
    return getPull(db, id);
  });
}

export function getPull(db, id) {
  return plain(db.prepare('SELECT * FROM pull_request WHERE id = ?').get(id));
}

export function getPullByNumber(db, repoId, number) {
  return plain(
    db.prepare('SELECT * FROM pull_request WHERE repo_id = ? AND number = ?').get(repoId, number)
  );
}

export function listPulls(db, repoId) {
  return plainAll(
    db.prepare('SELECT * FROM pull_request WHERE repo_id = ? ORDER BY number DESC').all(repoId)
  );
}

const PULL_PATCHABLE = {
  title: 'title',
  body: 'body',
  state: 'state',
  baseSha: 'base_sha',
  headSha: 'head_sha',
  diffMode: 'diff_mode',
};

export function updatePull(db, id, patch) {
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(PULL_PATCHABLE)) {
    if (patch[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(patch[key]);
    }
  }
  if (!sets.length) return getPull(db, id);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  db.prepare(`UPDATE pull_request SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  return getPull(db, id);
}

/** Counts for the tab strip: conversation threads vs file-anchored ones. */
export function tabCounts(db, pullRequestId) {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE file_path IS NULL)     AS conversation,
         COUNT(*) FILTER (WHERE file_path IS NOT NULL) AS files,
         COUNT(*) FILTER (WHERE status = 'open')       AS open
       FROM thread WHERE pull_request_id = ?`
    )
    .get(pullRequestId);
  return plain(row);
}
