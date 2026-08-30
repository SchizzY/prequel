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
 * @param {number} endHint       the end of the range recorded at the time
 * @returns {{anchorState, startLine, endLine, moved}}
 */
export function relocate(lines, snapshot, hint, endHint = hint) {
  // Where the snapshot cannot decide the span, the range the thread was filed
  // with is the best answer -- collapsing a comment on lines 10-20 to line 10
  // loses the reviewer's own statement of what they were talking about.
  const keptEnd = Number.isFinite(endHint) && endHint >= hint ? endHint : hint;

  if (lines === null) {
    return { anchorState: 'lost', startLine: hint, endLine: keptEnd, moved: false };
  }

  // No snapshot (a comment can be filed without one): the most we can say is
  // whether the line still exists.
  if (!snapshot || !snapshot.length) {
    const inRange = Number.isFinite(hint) && hint >= 1 && hint <= lines.length;
    return {
      anchorState: inRange ? 'current' : 'lost',
      startLine: hint,
      endLine: keptEnd,
      moved: false,
    };
  }

  // How wide the comment is. The snapshot decides it when it covers the whole
  // range, but a thread can be filed on lines 10-20 with a one-line snapshot --
  // `snapshotForRange` skips lines that are not in the DOM, and the API does
  // not require the two to agree -- and then the snapshot's width would silently
  // shrink the reviewer's range to a single line. Take whichever is wider.
  const span = Math.max(snapshot.length - 1, keptEnd - hint);

  // Still exactly where we left it: the common case, and the cheap one.
  if (Number.isFinite(hint)) {
    const here = lines.slice(hint - 1, hint - 1 + snapshot.length);
    if (here.length === snapshot.length && here.every((l, i) => l === snapshot[i])) {
      return {
        anchorState: 'current',
        startLine: hint,
        endLine: Math.min(hint + span, lines.length),
        moved: false,
      };
    }
  }

  // A range carried over from where the comment used to be can run off the end
  // of a file the PR has since truncated. An end line that is not in the file
  // is one the diff cannot render, and the thread would be filed away as
  // "not shown in this view" while its start line sits in plain sight.
  const endAt = (at) => Math.min(at + span, lines.length);

  const verbatim = findAll(lines, snapshot, exact);
  if (verbatim.length) {
    const at = nearest(verbatim, hint);
    return { anchorState: 'current', startLine: at, endLine: endAt(at), moved: at !== hint };
  }

  // Reformatted or re-indented: the code is recognisably still there, but it
  // has been touched, so flag it rather than pretending nothing happened.
  const fuzzy = findAll(lines, snapshot, loose);
  if (fuzzy.length) {
    const at = nearest(fuzzy, hint);
    return { anchorState: 'outdated', startLine: at, endLine: endAt(at), moved: at !== hint };
  }

  return { anchorState: 'lost', startLine: hint, endLine: keptEnd, moved: false };
}

/**
 * Re-anchor every file-anchored thread on a PR against the current tree.
 * Returns a per-thread summary so callers can report what moved.
 */
export async function reanchorPull(
  db,
  { repoRoot, pullRequestId, rev = 'WORKTREE', baseRev = null, persist = true }
) {
  const threads = listThreads(db, pullRequestId, { anchored: true });
  const fileCache = new Map();
  const shaCache = new Map();
  const changes = [];

  const read = async (revision, filePath) => {
    const key = `${revision}:${filePath}`;
    if (!fileCache.has(key)) {
      fileCache.set(key, await readFileLines(repoRoot, { rev: revision, path: filePath }));
      shaCache.set(key, await getBlobSha(repoRoot, { rev: revision, path: filePath }));
    }
    return { lines: fileCache.get(key), sha: shaCache.get(key) };
  };

  for (const thread of threads) {
    // Whole-file comments have no line to lose.
    if (thread.side === 'file') continue;

    // Which revision this comment is actually about. An old-side comment
    // addresses the base: its snapshot is code the PR removed, so looking for
    // it in the new file finds nothing and buries a perfectly good "why was
    // this deleted?" -- or finds the same text elsewhere and rewrites an
    // old-side line number to a new-side one, pointing at unrelated code.
    // Without a base revision to read there is nothing useful to compare, so
    // the thread is left exactly as it is.
    const side = thread.side === 'old' ? 'old' : 'new';
    if (side === 'old' && !baseRev) continue;
    const revision = side === 'old' ? baseRev : rev;

    const { lines, sha } = await read(revision, thread.file_path);

    // The file could not be read at this revision at all. For the new side
    // that means the PR deleted it, which is exactly what `lost` is for. For
    // the old side it usually means something duller -- the base branch is not
    // fetched here, or the file was renamed, so the thread carries the new
    // path and `git show base:newPath` was never going to find it. Concluding
    // "the code is gone" from that would drop a live finding out of every
    // agent's work queue, so leave the thread exactly as it is.
    if (lines === null && side === 'old') continue;

    // The file is byte-identical to when the comment was written, so nothing
    // can have moved. Skips the scan for the overwhelmingly common case.
    if (sha && thread.blob_sha === sha && thread.anchor_state === 'current') continue;

    const result = relocate(lines, thread.line_snapshot, thread.start_line, thread.end_line);

    // Threads are snapshotted against the working tree. When we are reading
    // some other revision -- a PR about a branch this checkout is not standing
    // on -- what we find there is a statement about the tree we happen to be
    // looking at, not about the thread. Report it, but do not write it down:
    // neither a `lost` verdict nor a line number from a foreign revision is
    // allowed to overwrite what the thread was actually filed against.
    if (!persist) {
      if (result.anchorState !== thread.anchor_state || result.startLine !== thread.start_line) {
        changes.push({
          threadId: thread.id,
          filePath: thread.file_path,
          from: thread.start_line,
          to: result.startLine,
          anchorState: result.anchorState,
          moved: result.moved,
          persisted: false,
        });
      }
      continue;
    }

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
