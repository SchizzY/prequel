// Builds everything a diff page needs: the parsed patch, highlighted HTML, the
// file tree and the summary line. Extracted so the original single-page route
// and the new Files changed tab render from one pipeline rather than two.

import { getDiff } from '../git/gitService.js';
import { parseDiff } from '../git/diffParser.js';
import { annotateWordDiffs } from './wordDiff.js';
import { highlightDiff } from './highlighter.js';
import { renderDiff, renderFileTree } from './renderer.js';
import { sampleDiff } from '../sampleDiff.js';

export const DIFF_MODES = ['all', 'branch', 'working'];

/** Normalise the query string knobs shared by every diff page. */
export function diffOptions(query, { defaultBase = null, defaultMode = 'working' } = {}) {
  return {
    view: query.view === 'unified' ? 'unified' : 'split',
    colorMode: ['light', 'dark'].includes(query.mode) ? query.mode : 'auto',
    diffMode: DIFF_MODES.includes(query.diff) ? query.diff : defaultMode,
    base: (typeof query.base === 'string' && query.base ? query.base : null) || defaultBase,
  };
}

export async function buildDiffView(repoRoot, { base, diffMode, view, head: headRef = null }) {
  let diff;
  let head;
  let resolvedBase;
  let error = null;
  // Where the new side is read from. A PR about a branch that is not checked
  // out reads from that branch instead of the working tree; getDiff decides,
  // and says so, so the diff and the context it expands cannot disagree.
  let rev = repoRoot && diffMode === 'branch' ? 'HEAD' : 'WORKTREE';

  if (repoRoot) {
    try {
      const result = await getDiff(repoRoot, { base, mode: diffMode, head: headRef });
      diff = parseDiff(result.patch);
      head = result.head;
      resolvedBase = result.base;
      rev = result.mode === 'branch' ? result.rev : 'WORKTREE';
    } catch (err) {
      error = err.message;
    }
  }

  if (!diff) {
    // No repo (or git failed): fall back to the built-in sample so the UI still
    // demonstrates. `error` surfaces any git failure.
    diff = sampleDiff;
    head = sampleDiff.head;
    resolvedBase = sampleDiff.base;
  }

  annotateWordDiffs(diff); // intra-line changed ranges (before highlighting)
  await highlightDiff(diff); // attaches per-line highlighted HTML in place

  const { filesHtml, summary } = renderDiff(diff, { view, rev });
  const treeHtml = diff.files.length ? renderFileTree(diff) : '';

  return { diff, head, base: resolvedBase, error, filesHtml, treeHtml, summary, rev };
}
