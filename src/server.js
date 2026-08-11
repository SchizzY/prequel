import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { renderDiff, renderFileTree } from './render/renderer.js';
import { highlightDiff, highlightLines } from './render/highlighter.js';
import { annotateWordDiffs } from './render/wordDiff.js';
import { getDiff, getBlobLines } from './git/gitService.js';
import { parseDiff, inferLanguage } from './git/diffParser.js';
import { sampleDiff } from './sampleDiff.js';
import {
  listComments,
  addComment,
  updateComment,
  deleteComment,
  clearComments,
  restoreCleared,
} from './comments/commentStore.js';
import { buildMarkdown, buildJson } from './export/claudeExport.js';
import { marked } from 'marked';

marked.setOptions({ breaks: true });

// Add rendered markdown (bodyHtml) for the client to display.
function withHtml(c) {
  return { ...c, bodyHtml: marked.parse(c.body || '') };
}

// Best-effort: add ".prequel/" to the repo's local git exclude so exported
// review files don't appear as untracked in the diff or get committed. Uses
// .git/info/exclude so the user's tracked .gitignore is left untouched.
async function ensureExcluded(repoRoot) {
  try {
    const p = path.join(repoRoot, '.git', 'info', 'exclude');
    let cur = '';
    try {
      cur = await fs.readFile(p, 'utf8');
    } catch {
      /* file may not exist yet */
    }
    if (cur.split('\n').some((l) => l.trim() === '.prequel/')) return;
    const prefix = cur && !cur.endsWith('\n') ? cur + '\n' : cur;
    await fs.writeFile(p, prefix + '.prequel/\n');
  } catch {
    /* .git may be a file (worktree/submodule) or unwritable — ignore */
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const DIFF_MODES = ['all', 'branch', 'working'];

export function createServer({ repoRoot = null, defaultBase = null } = {}) {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(projectRoot, 'views'));

  app.use(express.json({ limit: '1mb' }));
  app.use('/static', express.static(path.join(projectRoot, 'public')));
  app.use(
    '/vendor/primer',
    express.static(path.join(projectRoot, 'node_modules/@primer/primitives/dist/css'))
  );

  app.get('/', async (req, res) => {
    // ?view=split|unified (layout); ?mode=light|dark (color); default auto.
    const view = req.query.view === 'unified' ? 'unified' : 'split';
    const colorMode = ['light', 'dark'].includes(req.query.mode) ? req.query.mode : 'auto';
    // ?diff=all|branch|working (which changes to show); ?base=<ref>.
    const diffMode = DIFF_MODES.includes(req.query.diff) ? req.query.diff : 'working';
    const requestedBase =
      (typeof req.query.base === 'string' && req.query.base ? req.query.base : null) || defaultBase;

    let diff;
    let head;
    let base;
    let error = null;

    if (repoRoot) {
      try {
        const result = await getDiff(repoRoot, { base: requestedBase, mode: diffMode });
        diff = parseDiff(result.patch);
        head = result.head;
        base = result.base;
      } catch (err) {
        error = err.message;
      }
    }

    if (!diff) {
      // No repo (or git failed): fall back to the built-in sample so the UI
      // still demonstrates. `error` surfaces any git failure.
      diff = sampleDiff;
      head = sampleDiff.head;
      base = sampleDiff.base;
    }

    annotateWordDiffs(diff); // intra-line changed ranges (before highlighting)
    await highlightDiff(diff); // attaches per-line highlighted HTML in place
    // Which revision the "new" side comes from, for context expansion:
    // branch mode diffs against HEAD; all/working show the working tree.
    const rev = repoRoot && diffMode === 'branch' ? 'HEAD' : 'WORKTREE';
    const { filesHtml, summary } = renderDiff(diff, { view, rev });
    const treeHtml = diff.files.length ? renderFileTree(diff) : '';
    res.render('review', {
      repoPath: repoRoot || process.cwd(),
      isRepo: Boolean(repoRoot),
      base,
      head,
      diffMode,
      colorMode,
      view,
      error,
      filesHtml,
      treeHtml,
      summary,
      commentsEnabled: Boolean(repoRoot),
    });
  });

  // On-demand context lines for hunk expansion.
  // ?path=&rev=HEAD|WORKTREE&start=&end= (new-side line numbers, 1-based).
  app.get('/api/context', async (req, res) => {
    if (!repoRoot) return res.status(400).json({ error: 'no repo' });
    const filePath = String(req.query.path || '');
    const rev = req.query.rev === 'HEAD' ? 'HEAD' : 'WORKTREE';
    const start = parseInt(req.query.start, 10);
    const end = parseInt(req.query.end, 10);
    if (!filePath || !Number.isFinite(start) || !Number.isFinite(end)) {
      return res.status(400).json({ error: 'bad params' });
    }
    try {
      const { lines, from, eof } = await getBlobLines(repoRoot, { rev, path: filePath, start, end });
      const html = await highlightLines(lines, inferLanguage(filePath));
      res.json({ from, eof, lines, html });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- review comments ---------------------------------------------------
  app.get('/api/comments', async (req, res) => {
    if (!repoRoot) return res.json({ comments: [] });
    const branch = req.query.branch ? String(req.query.branch) : null;
    const comments = await listComments(repoRoot, branch);
    res.json({ comments: comments.map(withHtml) });
  });

  app.post('/api/comments', async (req, res) => {
    if (!repoRoot) return res.status(400).json({ error: 'no repo' });
    const b = req.body || {};
    const side = b.side === 'old' ? 'old' : b.side === 'file' ? 'file' : 'new';
    // file-level comments aren't tied to a line
    const startLine = side === 'file' ? 0 : Number(b.startLine);
    if (!b.filePath || !b.body || (side !== 'file' && !Number.isFinite(startLine))) {
      return res.status(400).json({ error: 'bad params' });
    }
    const comment = await addComment(repoRoot, {
      filePath: String(b.filePath),
      side,
      startLine,
      endLine: side === 'file' ? 0 : Number.isFinite(Number(b.endLine)) ? Number(b.endLine) : startLine,
      body: String(b.body),
      branch: b.branch ? String(b.branch) : null,
      lineSnapshot: Array.isArray(b.lineSnapshot) ? b.lineSnapshot.map(String) : [],
    });
    res.json({ comment: withHtml(comment) });
  });

  app.patch('/api/comments/:id', async (req, res) => {
    if (!repoRoot) return res.status(400).json({ error: 'no repo' });
    const b = req.body || {};
    const patch = {};
    if (typeof b.body === 'string') patch.body = b.body;
    if (b.status === 'open' || b.status === 'resolved') patch.status = b.status;
    const comment = await updateComment(repoRoot, req.params.id, patch);
    if (!comment) return res.status(404).json({ error: 'not found' });
    res.json({ comment: withHtml(comment) });
  });

  app.delete('/api/comments/:id', async (req, res) => {
    if (!repoRoot) return res.status(400).json({ error: 'no repo' });
    const ok = await deleteComment(repoRoot, req.params.id);
    res.json({ ok });
  });

  // Bulk clear (with undo) for a clean slate between review rounds.
  app.post('/api/comments/clear', async (req, res) => {
    if (!repoRoot) return res.status(400).json({ error: 'no repo' });
    const branch = req.body?.branch ? String(req.body.branch) : null;
    const cleared = await clearComments(repoRoot, branch);
    res.json({ cleared });
  });

  app.post('/api/comments/restore', async (req, res) => {
    if (!repoRoot) return res.status(400).json({ error: 'no repo' });
    const restored = await restoreCleared(repoRoot);
    res.json({ restored });
  });

  // Build the Claude payload, write it to <repo>/.prequel/, and return it so the
  // client can also copy it to the clipboard.
  app.post('/api/export', async (req, res) => {
    if (!repoRoot) return res.status(400).json({ error: 'no repo' });
    const branch = req.body?.branch ? String(req.body.branch) : null;
    const format = req.body?.format === 'json' ? 'json' : 'md';
    const comments = await listComments(repoRoot, branch);
    if (!comments.length) return res.json({ count: 0, content: '', path: null });

    const content =
      format === 'json' ? buildJson(comments) : buildMarkdown(repoRoot, branch, comments);
    // filesystem-safe timestamp: 2026-07-17-16-40-00
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const dir = path.join(repoRoot, '.prequel');
    const filename = `review-${ts}.${format}`;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, filename), content);
      await ensureExcluded(repoRoot); // keep .prequel/ out of the diff & commits
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ count: comments.length, content, path: path.join('.prequel', filename) });
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  return app;
}
