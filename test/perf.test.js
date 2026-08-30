// The diff view has to stay openable. These are the properties that decide
// whether it does: bounded HTML, bounded work, and colours that are defined
// once rather than repeated on every token.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { createServer } from '../src/server.js';
import { buildDiffView, buildFileDiff } from '../src/render/diffView.js';
import { applyRenderBudget, RENDER_BUDGET_LINES, MAX_FILE_LINES } from '../src/render/renderer.js';

let repoDir;
let server;
let base;

// A repo whose diff is far bigger than the budget.
function makeBigRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-perf-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  for (let f = 0; f < 12; f++) {
    let s = '';
    for (let i = 0; i < 400; i++) s += `export function fn${f}_${i}(a, b) { return a * ${i} + b; }\n`;
    fs.writeFileSync(path.join(dir, `src${f}.js`), s);
  }
  git('add', '-A');
  git('commit', '-qm', 'base');
  for (let f = 0; f < 12; f++) {
    const p = path.join(dir, `src${f}.js`);
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 2) if (lines[i]) lines[i] = lines[i].replace('a * ', 'a + ');
    fs.writeFileSync(p, lines.join('\n'));
  }
  return dir;
}

before(async () => {
  repoDir = makeBigRepo();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-perf-db-'));
  const app = createServer({ repoRoot: repoDir, dbPath: path.join(dbDir, 'p.db') });
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

test('token colours are defined once, not repeated on every span', async () => {
  const built = await buildDiffView(repoDir, { base: null, diffMode: 'all', view: 'split' });
  // The old markup carried `style="color:…;--shiki-dark:…"` on every token:
  // five distinct values, hundreds of thousands of copies, half the page.
  assert.doesNotMatch(built.filesHtml, /--shiki-dark/);
  assert.doesNotMatch(built.filesHtml, /style="color:/);
  // and the palette they refer to is served instead
  assert.match(built.paletteCss, /--shiki-dark/);
  assert.ok(built.paletteCss.length < 20000, 'the palette is small by construction');
});

test('a diff larger than the budget does not render unbounded HTML', async () => {
  const built = await buildDiffView(repoDir, { base: null, diffMode: 'all', view: 'split' });
  assert.ok(built.budget.deferredFiles > 0, 'the oversized files are deferred');
  assert.ok(
    built.budget.renderedLines <= RENDER_BUDGET_LINES,
    `rendered ${built.budget.renderedLines} lines, budget is ${RENDER_BUDGET_LINES}`
  );
  // The real symptom was tens of megabytes of HTML and a frozen browser.
  assert.ok(
    built.filesHtml.length < 8 * 1024 * 1024,
    `page is ${(built.filesHtml.length / 1048576).toFixed(1)}MB`
  );
  // Every file is still listed — deferred means "rows on request", not hidden.
  assert.equal(built.diff.files.length, 12);
  assert.match(built.filesHtml, /data-deferred="1"/);
  assert.match(built.filesHtml, /load-file-diff/);
});

test('the budget defers whole files and never splits one', () => {
  const diff = {
    files: [
      { hunks: [{ lines: new Array(100).fill(0) }] },
      { hunks: [{ lines: new Array(MAX_FILE_LINES + 1).fill(0) }] },
      { hunks: [{ lines: new Array(100).fill(0) }] },
    ],
  };
  const out = applyRenderBudget(diff);
  assert.equal(diff.files[0].deferred, false);
  assert.equal(diff.files[1].deferred, true, 'one huge file is deferred on its own account');
  assert.equal(diff.files[2].deferred, false, 'and does not cost the file after it its place');
  assert.equal(out.renderedLines, 200);
});

test('a deferred file loads its rows on request', async () => {
  const res = await fetch(`${base}/api/file-diff?path=src11.js&view=split&diff=working`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.match(data.html, /<table class="diff-table/);
  assert.match(data.html, /data-path="src11.js"/);
  assert.doesNotMatch(data.html, /data-deferred/, 'an explicitly requested file is not deferred again');
  assert.ok(data.css.includes('--shiki-dark'), 'its palette rides along');
});

test('a file that is not in the diff is a 404, not a crash', async () => {
  const res = await fetch(`${base}/api/file-diff?path=nope.js&view=split&diff=working`);
  assert.equal(res.status, 404);
});

test('the served page is bounded in size and rows', async () => {
  const html = await (await fetch(`${base}/?live=0`)).text();
  const rows = (html.match(/<tr/g) || []).length;
  assert.ok(html.length < 8 * 1024 * 1024, `page is ${(html.length / 1048576).toFixed(1)}MB`);
  assert.ok(rows < 12000, `page has ${rows} table rows`);
  assert.match(html, /id="tok-palette"/, 'the palette is served with the page');
});
