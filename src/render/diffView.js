// Builds everything a diff page needs: the parsed patch, highlighted HTML, the
// file tree and the summary line. Extracted so the original single-page route
// and the new Files changed tab render from one pipeline rather than two.

import { getDiff } from '../git/gitService.js';
import { parseDiff } from '../git/diffParser.js';
import { annotateWordDiffs } from './wordDiff.js';
import { highlightDiff, paletteCss } from './highlighter.js';
import { renderDiff, renderFileTree, applyRenderBudget } from './renderer.js';
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

/**
 * One file's rows, for a diff the page deferred. Same pipeline as the page, so
 * a loaded file is indistinguishable from one that arrived with it -- just
 * asked for separately, and paid for only when someone wants to read it.
 */
export async function buildFileDiff(repoRoot, { base, diffMode, view, head = null, path }) {
  const result = await getDiff(repoRoot, { base, mode: diffMode, head, paths: [path] });
  const diff = parseDiff(result.patch);
  const file = diff.files.find((f) => f.newPath === path || f.oldPath === path);
  if (!file) return null;
  // Only this file, and it is being asked for explicitly, so no budget applies.
  diff.files = [file];
  file.deferred = false;
  annotateWordDiffs(diff);
  await highlightDiff(diff);
  const rev = result.mode === 'branch' ? result.rev : 'WORKTREE';
  const { filesHtml } = renderDiff(diff, { view, rev });
  return { html: filesHtml, css: paletteCss() };
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

  // Decide what the page will actually show *before* doing any of the work
  // that only matters for what it shows. Highlighting is the expensive stage --
  // seconds of blocking CPU on a large diff -- and there is no point spending
  // it on rows that are not going to be rendered.
  const budget = applyRenderBudget(diff);

  annotateWordDiffs(diff); // intra-line changed ranges (before highlighting)
  await highlightDiff(diff); // attaches per-line highlighted HTML in place

  const { filesHtml, summary } = renderDiff(diff, { view, rev });
  const treeHtml = diff.files.length ? renderFileTree(diff) : '';

  // The token colours the markup above refers to. Emitted as a stylesheet
  // rather than repeated on every span -- see highlighter.js.
  return {
    diff,
    head,
    base: resolvedBase,
    error,
    filesHtml,
    treeHtml,
    summary,
    rev,
    budget,
    paletteCss: paletteCss(),
  };
}
