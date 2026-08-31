// The PR object the original tool had no room for: the thing a description,
// a conversation and several reviews all hang off.

import path from 'node:path';

import { newId, plain, plainAll, tx } from '../db/index.js';

// path.basename knows the platform's separators, which a hand-rolled split did
// not: "C:\code\prequel" is one segment to a regex looking for slashes.
const repoName = (rootPath) => path.basename(rootPath) || rootPath;

export function ensureRepo(db, rootPath, name = null) {
  const found = plain(db.prepare('SELECT * FROM repo WHERE root_path = ?').get(rootPath));
  if (found) return found;
  const id = newId();
  db.prepare('INSERT INTO repo (id, root_path, name) VALUES (?, ?, ?)').run(
    id,
    rootPath,
    name || repoName(rootPath)
  );
  return plain(db.prepare('SELECT * FROM repo WHERE id = ?').get(id));
}

export function createPull(db, data) {
  return tx(db, () => {
    // Numbered across the whole store, not per repo: one server lists pull
    // requests from every repo you have added, so #7 has to name exactly one
    // of them. Safe under concurrency because tx() holds the write lock
    // across the read.
    //
    // Issued from a counter rather than MAX(number)+1, because deleting a PR
    // is a real delete: with MAX the next one silently reuses the number that
    // just came free, and every bookmark, exported review file and agent-held
    // reference to /pr/N quietly starts resolving to a different pull request.
    // MAX is still taken as a floor, so a store whose counter is missing or
    // behind cannot collide with a live row.
    const seq = db.prepare('SELECT next FROM pull_number').get();
    const { max } = db
      .prepare('SELECT COALESCE(MAX(number), 0) AS max FROM pull_request')
      .get();
    const next = Math.max(seq?.next ?? 1, max + 1);
    db.prepare('UPDATE pull_number SET next = ?').run(next + 1);
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

export function getPullByNumber(db, number) {
  return plain(db.prepare('SELECT * FROM pull_request WHERE number = ?').get(number));
}

export function listPulls(db, repoId) {
  return plainAll(
    db.prepare('SELECT * FROM pull_request WHERE repo_id = ? ORDER BY number DESC').all(repoId)
  );
}

/**
 * Every pull request in the store, whichever repo it belongs to, carrying the
 * repo it came from so the index can label it. This is the list the /pulls
 * page shows now that repos are something you add rather than something the
 * server was launched in.
 */
export function listAllPulls(db) {
  return plainAll(
    db
      .prepare(
        `SELECT p.*, r.name AS repo_name, r.root_path AS repo_path,
                a.handle AS author_handle
           FROM pull_request p
           JOIN repo r ON r.id = p.repo_id
           JOIN participant a ON a.id = p.author_id
          ORDER BY p.number DESC`
      )
      .all()
  );
}

/** Deleting a pull request takes its reviews, threads and timeline with it
 * (ON DELETE CASCADE), which is why removing one from the list is a delete
 * rather than a hide. */
export function deletePull(db, id) {
  return db.prepare('DELETE FROM pull_request WHERE id = ?').run(id).changes > 0;
}

export function getRepo(db, id) {
  return plain(db.prepare('SELECT * FROM repo WHERE id = ?').get(id));
}

export function getRepoByPath(db, rootPath) {
  return plain(db.prepare('SELECT * FROM repo WHERE root_path = ?').get(rootPath));
}

/** The repos the picker offers, with how many pull requests each one holds. */
export function listRepos(db) {
  return plainAll(
    db
      .prepare(
        `SELECT r.*, COUNT(p.id) AS pull_count
           FROM repo r LEFT JOIN pull_request p ON p.repo_id = r.id
          GROUP BY r.id
          ORDER BY r.created_at`
      )
      .all()
  );
}

/** Forget a repo you added by mistake. Refuses while it still has pull
 * requests -- dropping those silently is not what "remove from the list" means. */
export function deleteRepo(db, id) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM pull_request WHERE repo_id = ?').get(id);
  if (n > 0) return false;
  return db.prepare('DELETE FROM repo WHERE id = ?').run(id).changes > 0;
}

const PULL_PATCHABLE = {
  title: 'title',
  body: 'body',
  state: 'state',
  // Retargeting a PR is a property of the PR, not a view option: every tab and
  // the diff summary read base_ref, so changing it here changes all of them.
  baseRef: 'base_ref',
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
