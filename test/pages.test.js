// Renders the two pages against a real PR built through the API, so a template
// error is a test failure rather than something you find in the browser.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer } from '../src/server.js';

let base;
let server;
let repoDir;

// A real git repo, so the Files tab has an actual diff to render.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-pages-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'app.js'), 'const a = 1;\nconst b = 2;\n');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  git('checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'app.js'), 'const a = 1;\nconst b = 3;\nconst c = 4;\n');
  git('commit', '-qam', 'change b, add c');
  return dir;
}

before(async () => {
  repoDir = makeRepo();
  // Deliberately outside the repo: SQLite's -wal and -shm sidecars would
  // otherwise show up as untracked files in the diff being reviewed. The real
  // default (~/.prequel/prequel.db) is outside any repo for the same reason.
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-pages-db-'));
  const app = createServer({
    repoRoot: repoDir,
    dbPath: path.join(dbDir, 'prequel.db'),
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const post = (u, b) =>
    fetch(base + u, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    }).then((r) => r.json());

  await post('/api/participants', { handle: 'cahill', displayName: 'Cahill' });
  await post('/api/participants', { handle: 'claude', agentId: 'claude-code' });
  await post('/api/participants', { handle: 'codex', agentId: 'codex' });

  await post('/api/pulls', {
    handle: 'cahill',
    title: 'Change b and add c',
    body: 'Adjusts the constants.\n\n- bumps `b`\n- adds `c`',
    baseRef: 'main',
    headRef: 'feature',
  });

  // one full review from each agent
  const claudeReview = (await post('/api/pulls/1/reviews', { handle: 'claude' })).review;
  await post('/api/pulls/1/threads', {
    handle: 'claude',
    reviewId: claudeReview.id,
    filePath: 'app.js',
    side: 'new',
    startLine: 3,
    severity: 'blocking',
    body: '`c` is unused.',
  });
  await post(`/api/reviews/${claudeReview.id}/submit`, {
    body: 'One unused constant.',
    verdict: 'request_changes',
  });

  const codexReview = (await post('/api/pulls/1/reviews', { handle: 'codex' })).review;
  await post('/api/pulls/1/threads', {
    handle: 'codex',
    reviewId: codexReview.id,
    filePath: 'app.js',
    startLine: 2,
    severity: 'nit',
    body: 'Magic number.',
  });
  await post(`/api/reviews/${codexReview.id}/submit`, { body: 'Looks fine.', verdict: 'approve' });

  // a PR-level conversation thread with a reply
  const convo = (await post('/api/pulls/1/threads', {
    handle: 'cahill',
    body: 'Overall direction check — @claude thoughts?',
  })).thread;
  await post(`/api/threads/${convo.id}/comments`, { handle: 'claude', body: 'Reads fine to me.' });
});

after(() => {
  server?.close();
  try {
    fs.rmSync(repoDir, { recursive: true, force: true });
  } catch {
    /* windows may still hold the db file */
  }
});

const get = async (url) => {
  const res = await fetch(base + url);
  return { status: res.status, html: await res.text() };
};

// Shiki wraps every token in its own span, so source never appears as
// contiguous text in the markup. Strip tags before asserting on code content.
const text = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

test('the PR index lists pull requests', async () => {
  const { status, html } = await get('/pulls');
  assert.equal(status, 200);
  assert.match(html, /Change b and add c/);
  assert.match(html, /#1/);
  assert.match(html, /feature/);
});

test('the Conversation tab renders description, reviews and discussion', async () => {
  const { status, html } = await get('/pr/1');
  assert.equal(status, 200);

  // description, as rendered markdown
  assert.match(html, /Adjusts the constants/);
  assert.match(html, /<code>b<\/code>/);

  // both reviews, with their verdicts
  assert.match(html, /requested changes/);
  assert.match(html, /approved these changes/);
  assert.match(html, /One unused constant/);
  assert.match(html, /Looks fine/);

  // findings are listed under the review that raised them
  assert.match(html, /is unused/);
  assert.match(html, /sev-blocking/);

  // the conversation thread and its reply
  assert.match(html, /Overall direction check/);
  assert.match(html, /Reads fine to me/);

  // and a composer to add to it
  assert.match(html, /id="pr-comment-form"/);
});

test('the tab strip carries counts and marks the active tab', async () => {
  const { html } = await get('/pr/1');
  assert.match(html, /class="pr-tab is-active"[^>]*>\s*Conversation/);
  assert.match(html, /Files changed<span class="tab-count">2<\/span>/);
  assert.match(html, /Conversation<span class="tab-count">1<\/span>/);
});

test('the Files tab renders the diff under the same header', async () => {
  const { status, html } = await get('/pr/1/files');
  assert.equal(status, 200);

  // shared chrome
  assert.match(html, /Change b and add c/);
  assert.match(html, /class="pr-tab is-active"[^>]*>\s*Files changed/);

  // the actual diff: the PR defaults to branch mode, so the committed change
  // against main is what renders
  assert.match(html, /data-path="app\.js"/);
  assert.match(text(html), /const c = 4;/);
  assert.match(html, /changed\s*file/);

  // the existing diff scripts are still what drive it
  assert.match(html, /static\/js\/comments\.js/);
});

test('view and diff mode remain switchable on the Files tab', async () => {
  const unified = await get('/pr/1/files?view=unified');
  assert.match(unified.html, /data-view="unified"/);
  const split = await get('/pr/1/files?view=split');
  assert.match(split.html, /data-view="split"/);

  const working = await get('/pr/1/files?diff=working');
  assert.match(working.html, /data-diff="working"/);
});

test('an unknown PR renders a 404 page rather than throwing', async () => {
  const { status, html } = await get('/pr/999');
  assert.equal(status, 404);
  assert.match(html, /No pull request/);
  assert.match(html, /999/);
});

test('the original single-page route still renders', async () => {
  // It defaults to working mode, which is legitimately empty here: the fixture
  // repo has no uncommitted changes. Ask for branch mode to see the diff.
  const { status, html } = await get('/?diff=branch');
  assert.equal(status, 200);
  assert.match(html, /class="pr-title">Files changed/);
  assert.match(html, /data-path="app\.js"/);
  assert.match(text(html), /const c = 4;/);
});
