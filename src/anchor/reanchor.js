// Keeping comments attached to the code they were written about.
//
// A line number is not a durable address: the moment an agent edits the file,
// every comment below the edit points somewhere slightly wrong, and a comment
// on deleted code points at something unrelated. That is worse than useless --
// a reviewer acts on it, and acts on the wrong line.
//
// So the line number is a hint and `line_snapshot` (the code as it read when
// the comment was written) is the real locator. On each pass we look for the
// snapshot in the current file and record what we found:
//
//   current   found verbatim; start_line updated if it moved
//   outdated  found, but only ignoring whitespace -- the line was touched
//   lost      not found at all, or the file is gone
//
// `lost` is the important one. It does not delete anything; it drops the thread
// out of the work queue and marks it in the UI, so a human decides rather than
// an agent guessing at a stale line number.

import { readFileLines, getBlobSha } from '../git/gitService.js';
import { listThreads, updateAnchor } from '../model/threads.js';

/** Index of every position where `needle` occurs in `haystack`, 1-based. */
function findAll(haystack, needle, equal) {
  const hits = [];
  if (!needle.length || needle.length > haystack.length) return hits;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (!equal(haystack[i + j], needle[j])) continue outer;
    }
    hits.push(i + 1);
  }
  return hits;
}

const exact = (a, b) => a === b;
const loose = (a, b) => a.trim() === b.trim();

/** When code is duplicated, the match nearest where it used to be wins. */
function nearest(candidates, hint) {
  if (!Number.isFinite(hint)) return candidates[0];
  return candidates.reduce((best, c) =>
    Math.abs(c - hint) < Math.abs(best - hint) ? c : best
  );
}

/**
 * Decide where a single thread now points.
 * Pure, so the interesting cases are testable without a git repo.
 *
 * @param {string[]|null} lines  current file contents, or null if it is gone
 * @param {string[]} snapshot    code as it read when the comment was written
 * @param {number} hint          the line number recorded at the time
 * @returns {{anchorState, startLine, endLine, moved}}
 */
export function relocate(lines, snapshot, hint) {
  if (lines === null) {
    return { anchorState: 'lost', startLine: hint, endLine: hint, moved: false };
  }

  // No snapshot (a comment can be filed without one): the most we can say is
  // whether the line still exists.
  if (!snapshot || !snapshot.length) {
    const inRange = Number.isFinite(hint) && hint >= 1 && hint <= lines.length;
    return {
      anchorState: inRange ? 'current' : 'lost',
      startLine: hint,
      endLine: hint,
      moved: false,
    };
  }

  const span = snapshot.length - 1;

  // Still exactly where we left it: the common case, and the cheap one.
  if (Number.isFinite(hint)) {
    const here = lines.slice(hint - 1, hint - 1 + snapshot.length);
    if (here.length === snapshot.length && here.every((l, i) => l === snapshot[i])) {
      return { anchorState: 'current', startLine: hint, endLine: hint + span, moved: false };
    }
  }

  const verbatim = findAll(lines, snapshot, exact);
  if (verbatim.length) {
    const at = nearest(verbatim, hint);
    return { anchorState: 'current', startLine: at, endLine: at + span, moved: at !== hint };
  }

  // Reformatted or re-indented: the code is recognisably still there, but it
  // has been touched, so flag it rather than pretending nothing happened.
  const fuzzy = findAll(lines, snapshot, loose);
  if (fuzzy.length) {
    const at = nearest(fuzzy, hint);
    return { anchorState: 'outdated', startLine: at, endLine: at + span, moved: at !== hint };
  }

  return { anchorState: 'lost', startLine: hint, endLine: hint, moved: false };
}

/**
 * Re-anchor every file-anchored thread on a PR against the current tree.
 * Returns a per-thread summary so callers can report what moved.
 */
export async function reanchorPull(db, { repoRoot, pullRequestId, rev = 'WORKTREE' }) {
  const threads = listThreads(db, pullRequestId, { anchored: true });
  const fileCache = new Map();
  const shaCache = new Map();
  const changes = [];

  for (const thread of threads) {
    // Whole-file comments have no line to lose.
    if (thread.side === 'file') continue;

    if (!fileCache.has(thread.file_path)) {
      fileCache.set(thread.file_path, await readFileLines(repoRoot, { rev, path: thread.file_path }));
      shaCache.set(thread.file_path, await getBlobSha(repoRoot, { rev, path: thread.file_path }));
    }
    const lines = fileCache.get(thread.file_path);
    const sha = shaCache.get(thread.file_path);

    // The file is byte-identical to when the comment was written, so nothing
    // can have moved. Skips the scan for the overwhelmingly common case.
    if (sha && thread.blob_sha === sha && thread.anchor_state === 'current') continue;

    const result = relocate(lines, thread.line_snapshot, thread.start_line);

    const unchanged =
      result.anchorState === thread.anchor_state &&
      result.startLine === thread.start_line &&
      thread.blob_sha === sha;
    if (unchanged) continue;

    updateAnchor(db, thread.id, {
      startLine: result.startLine,
      endLine: result.endLine,
      anchorState: result.anchorState,
      blobSha: sha,
    });
    changes.push({
      threadId: thread.id,
      filePath: thread.file_path,
      from: thread.start_line,
      to: result.startLine,
      anchorState: result.anchorState,
      moved: result.moved,
    });
  }

  return changes;
}
