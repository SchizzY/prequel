import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { renderDiff, renderFileTree, applyRenderBudget } from './render/renderer.js';
import { highlightDiff, highlightLines, paletteCss } from './render/highlighter.js';
import { annotateWordDiffs } from './render/wordDiff.js';
import { getDiff, getBlobLines, listBranches, resolveHeadRev } from './git/gitService.js';
import { buildFileDiff } from './render/diffView.js';
import { parseDiff, inferLanguage } from './git/diffParser.js';
import { sampleDiff } from './sampleDiff.js';
import {
  listComments,
  addComment,
  getComment,
  updateComment,
  deleteComment,
  clearComments,
  restoreCleared,
} from './comments/commentStore.js';
import { buildMarkdown, buildJson } from './export/claudeExport.js';
import { openDb } from './db/index.js';
import { getPullByNumber, getRepo } from './model/pulls.js';
import { mountApi } from './api/routes.js';
import { mountPages } from './pages/routes.js';
import { renderMarkdown } from './render/markdown.js';

// Add rendered markdown (bodyHtml) for the client to display.
function withHtml(c) {
  return { ...c, bodyHtml: renderMarkdown(c.body) };
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

export function createServer({ repoRoot = null, defaultBase = null, dbPath } = {}) {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(projectRoot, 'views'));

  // Binding to loopback keeps other machines out; it does nothing about the
  // browser already running on this one. Any page the user visits can reach
  // http://127.0.0.1:<port>/, and this server spawns git, opens OS dialogs and
  // knows every repo the user has added -- so requests have to be shown to
  // come from prequel's own pages rather than merely to arrive here.
  //
  //   Host      a name that resolves to 127.0.0.1 but is not it defeats the
  //             loopback bind entirely (DNS rebinding), so the header is
  //             pinned to the addresses the server actually answers on.
  //   Origin    a cross-origin write is refused outright.
  //   Sec-Fetch a subresource, form post or framed load from another site is
  //             refused; the user clicking a link to here is not.
  //
  // Every spelling of loopback is accepted, since a person may well have typed
  // one: 127.0.0.1, the short forms git and curl take, IPv6, and the
  // IPv4-mapped form. Anything else is either a rebinding attempt or a
  // deployment this tool does not support.
  const LOOPBACK_HOST =
    /^(localhost|127(\.\d{1,3}){1,3}|\[?::1\]?|\[?::ffff:127(\.\d{1,3}){1,3}\]?)(:\d+)?$/i;

  app.use((req, res, next) => {
    // Set before any early return, so a refused request carries them too.
    res.setHeader(
      'content-security-policy',
      [
        "default-src 'self'",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
      ].join('; ')
    );
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');

    // Fail closed: a request with no Host at all is not one a browser sends.
    const host = req.headers.host || '';
    if (!LOOPBACK_HOST.test(host)) {
      return res.status(403).json({ error: 'host not allowed' });
    }

    const site = req.get('sec-fetch-site');
    const dest = req.get('sec-fetch-dest');
    // A cross-site request is allowed only when it is the user actually
    // navigating here -- following a link, in the top-level page. An iframe
    // load is also `mode: navigate`, so the destination is what separates
    // "someone clicked a link" from "a hidden frame on another site loaded
    // this URL", which matters because these GETs run git and re-anchor.
    if (site === 'cross-site' && dest !== 'document') {
      return res.status(403).json({ error: 'cross-site request refused' });
    }

    const writes = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (writes) {
      // Nothing legitimately writes here from another site -- the exemption
      // above is for a person following a link, which is a GET. Refusing the
      // whole class means Origin is not the only thing standing in the way of
      // a cross-site form post.
      if (site === 'cross-site') {
        return res.status(403).json({ error: 'cross-site write refused' });
      }
      const origin = req.get('origin');
      if (origin) {
        let originHost = null;
        try {
          originHost = new URL(origin).host;
        } catch {
          /* unparseable Origin is not one of ours */
        }
        if (!originHost || originHost !== host) {
          return res.status(403).json({ error: 'cross-origin write refused' });
        }
      }
    }

    next();
  });

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

    // Same budget as the PR pages: decide what is rendered before paying to
    // highlight it. Everything else loads on request.
    applyRenderBudget(diff);
    annotateWordDiffs(diff); // intra-line changed ranges (before highlighting)
    await highlightDiff(diff); // attaches per-line highlighted HTML in place
    // Which revision the "new" side comes from, for context expansion:
    // branch mode diffs against HEAD; all/working show the working tree.
    const rev = repoRoot && diffMode === 'branch' ? 'HEAD' : 'WORKTREE';
    const { filesHtml, summary } = renderDiff(diff, { view, rev });
    const treeHtml = diff.files.length ? renderFileTree(diff) : '';
    // Options for the base picker in the header; empty outside a repo, where
    // the sample diff's base is not a real ref.
    const branches = repoRoot ? await listBranches(repoRoot) : { local: [], remote: [] };
    res.render('review', {
      repoPath: repoRoot || process.cwd(),
      isRepo: Boolean(repoRoot),
      base,
      branches,
      head,
      diffMode,
      colorMode,
      view,
      error,
      filesHtml,
      treeHtml,
      summary,
      paletteCss: paletteCss(),
      commentsEnabled: Boolean(repoRoot),
    });
  });

  // Where a page's context lines come from. The Files tab sends the PR it is
  // showing (?pr=), because that PR may live in another repo, or on a branch
  // this checkout is not standing on -- expanding a hunk has to read the same
  // code the diff around it came from. Without a PR this is the standalone
  // review page, which is always about the repo prequel was started in.
  async function contextSource(req) {
    const number = Number(req.query.pr);
    const db = app.locals.db;
    if (!db || !Number.isInteger(number)) return { root: repoRoot, committed: 'HEAD' };
    const pull = getPullByNumber(db, number);
    if (!pull) return { root: repoRoot, committed: 'HEAD' };
    const root = getRepo(db, pull.repo_id)?.root_path || repoRoot;
    return { root, committed: (await resolveHeadRev(root, pull.head_ref)).rev };
  }

  // On-demand context lines for hunk expansion.
  // ?path=&rev=HEAD|WORKTREE&start=&end=&pr= (new-side line numbers, 1-based).
  app.get('/api/context', async (req, res) => {
    if (!repoRoot) return res.status(400).json({ error: 'no repo' });
    const filePath = String(req.query.path || '');
    const start = parseInt(req.query.start, 10);
    const end = parseInt(req.query.end, 10);
    if (!filePath || !Number.isFinite(start) || !Number.isFinite(end)) {
      return res.status(400).json({ error: 'bad params' });
    }
    try {
      const source = await contextSource(req);
      // The client says which side it wants, not which ref: the ref is this
      // server's business, so a request can never name an arbitrary revision.
      const rev = req.query.rev && req.query.rev !== 'WORKTREE' ? source.committed : 'WORKTREE';
      const { lines, from, eof } = await getBlobLines(source.root, { rev, path: filePath, start, end });
      const html = await highlightLines(lines, inferLanguage(filePath));
      // Expanded context can use a token colour the page was not rendered
      // with, so the palette rides along and the client tops up its stylesheet.
      res.json({ from, eof, lines, html, css: paletteCss() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // One deferred file's rows. The page renders up to a budget and leaves the
  // rest as headers; this is what fills one in when someone asks for it.
  app.get('/api/file-diff', async (req, res) => {
    if (!repoRoot) return res.status(400).json({ error: 'no repo' });
    const filePath = String(req.query.path || '');
    if (!filePath) return res.status(400).json({ error: 'bad params' });
    const view = req.query.view === 'unified' ? 'unified' : 'split';
    const diffMode = DIFF_MODES.includes(req.query.diff) ? req.query.diff : 'working';
    try {
      // A PR names the repo and branch its diff came from; without one this is
      // the standalone page, which is always about the launch repo.
      const number = Number(req.query.pr);
      const db = app.locals.db;
      let root = repoRoot;
      let head = null;
      let base = req.query.base ? String(req.query.base) : defaultBase;
      if (db && Number.isInteger(number)) {
        const pull = getPullByNumber(db, number);
        if (pull) {
          root = getRepo(db, pull.repo_id)?.root_path || repoRoot;
          head = pull.head_ref;
          base = req.query.base ? String(req.query.base) : pull.base_ref || defaultBase;
        }
      }
      const built = await buildFileDiff(root, { base, diffMode, view, head, path: filePath });
      if (!built) return res.status(404).json({ error: 'file not in this diff' });
      res.json(built);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- live updates (SSE) -------------------------------------------------
  // Every mutation is broadcast so open pages reflect changes made elsewhere —
  // notably by Claude working the review through the API.
  const sseClients = new Set();

  // `origin` is the client id sent by whoever made the change; that client
  // already applied it locally and skips its own echo.
  function emit(type, data, req) {
    const payload = JSON.stringify({ type, origin: req?.get('x-prequel-client') || null, ...data });
    for (const client of sseClients) {
      try {
        client.write(`data: ${payload}\n\n`);
      } catch {
        /* dropped connection; the close handler will evict it */
      }
    }
  }

  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    sseClients.add(res);
    // Comment-only frames keep the connection from idling out.
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });

  // --- multi-reviewer API -------------------------------------------------
  // Threads, reviews and participants live in SQLite. Mounted alongside the
  // original /api/comments routes rather than replacing them, so the existing
  // single-agent skill keeps working while the new model is wired up.
  if (repoRoot) {
    const db = openDb(dbPath);
    app.locals.db = db;
    mountApi(app, db, { repoRoot, emit });
    mountPages(app, db, { repoRoot, defaultBase });
  }

  // --- review comments ---------------------------------------------------
  app.get('/api/comments', async (req, res) => {
    if (!repoRoot) return res.json({ comments: [] });
    const branch = req.query.branch ? String(req.query.branch) : null;
    // Optional filters; omit them all to get everything (what the UI wants).
    //   ?status=open|resolved   ?author=user|claude   ?roots=1 (exclude replies)
    const status = ['open', 'resolved'].includes(req.query.status) ? req.query.status : null;
    const author = ['user', 'claude'].includes(req.query.author) ? req.query.author : null;
    const rootsOnly = req.query.roots === '1';
    let comments = await listComments(repoRoot, branch);
    // Comments predating these fields are treated as open, user-authored roots.
    if (status) comments = comments.filter((c) => (c.status || 'open') === status);
    if (author) comments = comments.filter((c) => (c.author || 'user') === author);
    if (rootsOnly) comments = comments.filter((c) => !c.parentId);
    res.json({ comments: comments.map(withHtml) });
  });

  app.post('/api/comments', async (req, res) => {
    if (!repoRoot) return res.status(400).json({ error: 'no repo' });
    const b = req.body || {};
    const author = b.author === 'claude' ? 'claude' : 'user';

    // A reply carries only { parentId, body } — it inherits its anchor from the
    // comment it answers, so the two can never drift apart.
    if (b.parentId) {
      const parent = await getComment(repoRoot, String(b.parentId));
      if (!parent) return res.status(404).json({ error: 'parent not found' });
      if (parent.parentId) return res.status(400).json({ error: 'cannot reply to a reply' });
      if (!b.body) return res.status(400).json({ error: 'bad params' });
      const reply = await addComment(repoRoot, {
        parentId: parent.id,
        author,
        filePath: parent.filePath,
        side: parent.side,
        startLine: parent.startLine,
        endLine: parent.endLine,
        body: String(b.body),
        branch: parent.branch ?? null,
        lineSnapshot: [],
      });
      emit('comment.created', { comment: withHtml(reply) }, req);
      return res.json({ comment: withHtml(reply) });
    }

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
      author,
      parentId: null,
    });
    emit('comment.created', { comment: withHtml(comment) }, req);
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
    emit('comment.updated', { comment: withHtml(comment) }, req);
    res.json({ comment: withHtml(comment) });
  });

  app.delete('/api/comments/:id', async (req, res) => {
    if (!repoRoot) return res.status(400).json({ error: 'no repo' });
    const removed = await deleteComment(repoRoot, req.params.id);
    if (removed) emit('comment.deleted', { id: req.params.id }, req);
    res.json({ ok: Boolean(removed), removed });
  });

  // Bulk clear (with undo) for a clean slate between review rounds.
  app.post('/api/comments/clear', async (req, res) => {
    if (!repoRoot) return res.status(400).json({ error: 'no repo' });
    const branch = req.body?.branch ? String(req.body.branch) : null;
    const cleared = await clearComments(repoRoot, branch);
    emit('comments.reset', {}, req);
    res.json({ cleared });
  });

  app.post('/api/comments/restore', async (req, res) => {
    if (!repoRoot) return res.status(400).json({ error: 'no repo' });
    const restored = await restoreCleared(repoRoot);
    emit('comments.reset', {}, req);
    res.json({ restored });
  });

  // Build the Claude payload, write it to <repo>/.prequel/, and return it so the
  // client can also copy it to the clipboard.
  app.post('/api/export', async (req, res) => {
    if (!repoRoot) return res.status(400).json({ error: 'no repo' });
    const branch = req.body?.branch ? String(req.body.branch) : null;
    const format = req.body?.format === 'json' ? 'json' : 'md';
    // Replies (and anything Claude wrote) are conversation, not asks — the
    // export is the list of things being requested.
    const all = await listComments(repoRoot, branch);
    const comments = all.filter((c) => !c.parentId && (c.author || 'user') === 'user');
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

  // Identifies this server and the repo it serves, so a client scanning ports
  // can find the instance belonging to the repo it cares about.
  app.get('/healthz', (req, res) => res.json({ ok: true, app: 'prequel', repoRoot }));

  return app;
}
