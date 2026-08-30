// Import an existing ~/.prequel/<hash>.json comment store into SQLite.
//
// The old file has no PR object and no participants, so both are synthesised:
//   - each distinct `author` string becomes a participant
//   - each distinct `branch` becomes a pull request (comments written before
//     branch tracking have branch === null and land in one catch-all PR)
//   - each root comment becomes a thread carrying the anchor and status; its
//     replies become further comments on that thread
//
// Idempotent by original comment id: re-running will not duplicate anything.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { tx } from './index.js';
import { ensureParticipant } from '../model/participants.js';
import { ensureRepo, createPull, listPulls } from '../model/pulls.js';
import * as threads from '../model/threads.js';

const LEGACY_DIR = path.join(os.homedir(), '.prequel');

/** Legacy stores are named by a hash of the repo root; find them all. */
export function findLegacyStores(dir = LEGACY_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f))
    .filter((file) => {
      try {
        return typeof JSON.parse(fs.readFileSync(file, 'utf8')).repoRoot === 'string';
      } catch {
        return false;
      }
    });
}

// 'user' and 'claude' are the only two the old store could produce.
function participantFor(db, cache, author) {
  const handle = author || 'user';
  if (cache.has(handle)) return cache.get(handle);
  const known = { claude: 'claude-code', codex: 'codex' };
  const p = ensureParticipant(db, {
    handle,
    displayName: handle === 'user' ? 'You' : handle,
    agentId: known[handle] ?? null,
  });
  cache.set(handle, p);
  return p;
}

/**
 * @returns {{ repoRoot, pulls, threads, comments, skipped }} counts
 */
export function migrateStore(db, storeFile) {
  const data = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const repoRoot = data.repoRoot;
  const all = Array.isArray(data.comments) ? data.comments : [];
  const repo = ensureRepo(db, repoRoot);

  const stats = { repoRoot, pulls: 0, threads: 0, comments: 0, skipped: 0 };
  if (!all.length) return stats;

  const byId = new Map(all.map((c) => [c.id, c]));
  const roots = all.filter((c) => !c.parentId);
  const repliesFor = new Map();
  for (const c of all) {
    if (!c.parentId) continue;
    // a reply whose parent was deleted has nothing to attach to
    if (!byId.has(c.parentId)) {
      stats.skipped++;
      continue;
    }
    if (!repliesFor.has(c.parentId)) repliesFor.set(c.parentId, []);
    repliesFor.get(c.parentId).push(c);
  }

  const people = new Map();
  // Provenance, not heuristics: every imported row carries the id it had in the
  // JSON store, so a second run can tell exactly what it already brought across.
  const imported = threads.importedLegacyIds(db, repo.id);

  return tx(db, () => {
    const pullFor = new Map();
    const branches = [...new Set(roots.map((c) => c.branch ?? null))];
    for (const branch of branches) {
      const headRef = branch || 'unknown';
      const existing = listPulls(db, repo.id).find((p) => p.head_ref === headRef);
      if (existing) {
        pullFor.set(branch, existing);
        continue;
      }
      const author = participantFor(db, people, 'user');
      const pull = createPull(db, {
        repoId: repo.id,
        title: branch ? `Review of ${branch}` : 'Imported review comments',
        body: branch
          ? `Imported from the pre-SQLite comment store for branch \`${branch}\`.`
          : 'Imported comments that predate branch tracking.',
        authorId: author.id,
        baseRef: 'main',
        headRef,
      });
      pullFor.set(branch, pull);
      stats.pulls++;
    }

    for (const root of roots) {
      const pull = pullFor.get(root.branch ?? null);
      const author = participantFor(db, people, root.author);
      const anchored = Boolean(root.filePath) && root.side !== 'file';

      // Already brought across on an earlier run: keep the existing thread and
      // fall through, so replies added to it since then still get imported.
      let threadId = imported.has(root.id) ? threads.threadForLegacyId(db, root.id) : null;
      if (threadId) {
        stats.skipped++;
      } else {
        const thread = threads.createThread(db, {
          pullRequestId: pull.id,
          participantId: author.id,
          filePath: root.filePath ?? null,
          side: root.side === 'file' ? 'file' : (root.side ?? 'new'),
          startLine: anchored ? root.startLine : null,
          endLine: anchored ? (root.endLine ?? root.startLine) : null,
          lineSnapshot: root.lineSnapshot?.length ? root.lineSnapshot : null,
          body: root.body ?? '',
          legacyId: root.id,
        });
        threadId = thread.id;
        stats.threads++;
        stats.comments++;
        if ((root.status ?? 'open') === 'resolved') {
          threads.setStatus(db, threadId, 'resolved', author.id);
        }
      }

      const replies = (repliesFor.get(root.id) ?? []).sort((a, b) =>
        String(a.createdAt).localeCompare(String(b.createdAt))
      );
      for (const reply of replies) {
        if (imported.has(reply.id)) {
          stats.skipped++;
          continue;
        }
        threads.addComment(db, {
          threadId,
          participantId: participantFor(db, people, reply.author).id,
          body: reply.body ?? '',
          legacyId: reply.id,
        });
        stats.comments++;
      }
    }
    return stats;
  });
}

export function migrateAll(db, dir = LEGACY_DIR) {
  return findLegacyStores(dir).map((file) => migrateStore(db, file));
}
