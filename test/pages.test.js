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
let otherDir;

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
  for (const dir of [repoDir, otherDir]) {
    try {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows may still hold the db file */
    }
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
  // the composer posts as the human the store already knows, not a hardcoded 'user'
  assert.match(html, /<body data-me="cahill">/);
});

// The tab label now follows an icon, so match the whole anchor rather than
// what sits immediately after the opening tag.
const activeTab = (html) => (html.match(/<a class="pr-tab is-active"[\s\S]*?<\/a>/) || [''])[0];

test('the tab strip carries counts and marks the active tab', async () => {
  const { html } = await get('/pr/1');
  assert.match(activeTab(html), /Conversation/);
  // Files changed counts the files, the way GitHub's does -- the fixture
  // touches one, and the two threads written about it are shown per file.
  assert.match(html, /Files changed<span class="tab-count">1<\/span>/);
  assert.match(html, /Conversation<span class="tab-count">1<\/span>/);

  // and the same number on the tab whichever page you are standing on
  const onFiles = await get('/pr/1/files');
  assert.match(onFiles.html, /Files changed<span class="tab-count">1<\/span>/);
});

test('the conversation page carries the details rail and the diff summary', async () => {
  const { html } = await get('/pr/1');

  // reviewers, with the verdict each one left
  assert.match(html, /Reviewers/);
  assert.match(html, /class="verdict-mark verdict-changes"/);
  assert.match(html, /class="verdict-mark verdict-approve"/);

  // the findings raised, by severity, and who is on the hook for them
  assert.match(html, /Assignees/);
  assert.match(html, /Findings/);
  assert.match(html, /3 open · 0 resolved/);

  // everyone who has spoken: author, both agents
  assert.match(html, /3 participants/);

  // the header's +/- summary, which this page has no diff of its own to count
  assert.match(html, /class="summary-additions">\+2</);
  assert.match(html, /class="summary-deletions">−1</);
});

test('the header picks the base branch, and the choice sticks to the PR', async () => {
  const before = await get('/pr/1');
  assert.match(before.html, /class="ref-pill ref-select pr-base-select"/);
  // the branches this repo actually has, with the PR's own base selected
  assert.match(before.html, /<option value="main" selected>main<\/option>/);
  assert.match(before.html, /<option value="feature">feature<\/option>/);

  const patch = await fetch(`${base}/api/pulls/1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRef: 'feature' }),
  });
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).pull.base_ref, 'feature');

  // and the page now reads it back, rather than the base it was created with
  const after = await get('/pr/1');
  assert.match(after.html, /<option value="feature" selected>feature<\/option>/);

  // put it back: the rest of the suite diffs against main
  await fetch(`${base}/api/pulls/1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRef: 'main' }),
  });
});

test('the Files tab renders the diff under the same header', async () => {
  const { status, html } = await get('/pr/1/files');
  assert.equal(status, 200);

  // shared chrome
  assert.match(html, /Change b and add c/);
  assert.match(activeTab(html), /Files changed/);

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

// --- pull requests from another repo on disk -----------------------------
// The picker adds repos after the server is running, so a PR is not
// necessarily about the directory prequel was launched in -- nor about the
// branch that directory happens to be standing on.

const send = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
};

test('a folder is added by path, resolved to the repo root', async () => {
  otherDir = makeRepo();
  // Left on main: the PR below is about a branch this checkout is not on.
  execFileSync('git', ['-C', otherDir, 'checkout', '-q', 'main'], { stdio: 'pipe' });
  fs.mkdirSync(path.join(otherDir, 'src'), { recursive: true });

  // Pointing at a subdirectory is enough: it resolves to the repo root, which
  // is what makes the folder dialog usable -- you pick the folder you were
  // looking at, not the one with .git in it.
  const added = await send('POST', '/api/repos', { path: path.join(otherDir, 'src') });
  assert.equal(added.status, 200);
  assert.equal(added.repo.root_path.replace(/\\/g, '/'), otherDir.replace(/\\/g, '/'));
  assert.ok(added.branches.local.includes('feature'));
  assert.equal(added.head, 'main');

  const repos = await send('GET', '/api/repos');
  assert.equal(repos.repos.length, 2);
  assert.ok(repos.repos.some((r) => r.home));

  // A folder without git in it is refused, with the path in the message.
  const nope = await send('POST', '/api/repos', { path: os.tmpdir() });
  assert.equal(nope.status, 400);
  assert.match(nope.error, /not a git repository/);
});

test('a PR in the added repo diffs its own branch, not this checkout', async () => {
  const created = await send('POST', '/api/pulls', {
    handle: 'cahill',
    repoPath: otherDir,
    title: 'Work from the other repo',
    baseRef: 'main',
    headRef: 'feature',
  });
  assert.equal(created.status, 200);
  const number = created.pull.number;
  assert.notEqual(number, 1, 'numbers do not restart in a second repo');

  // main is checked out there, so this diff can only come from reading the
  // branch the PR names.
  const files = await get(`/pr/${number}/files`);
  assert.equal(files.status, 200);
  assert.match(text(files.html), /const c = 4;/);

  // and the index labels which repo it came from
  const index = await get('/pulls');
  assert.match(index.html, /class="repo-tag"/);
  assert.match(index.html, /Work from the other repo/);
});

test('a pull request can be deleted from the list', async () => {
  const before = await send('GET', '/api/pulls');
  const doomed = before.pulls.find((p) => p.title === 'Work from the other repo');

  const removed = await send('DELETE', `/api/pulls/${doomed.number}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.ok, true);

  const after = await send('GET', '/api/pulls');
  assert.equal(after.pulls.length, before.pulls.length - 1);
  assert.equal((await get(`/pr/${doomed.number}`)).status, 404);

  // With its last PR gone the repo can be forgotten too; the one prequel runs
  // in stays put.
  const repos = await send('GET', '/api/repos');
  const other = repos.repos.find((r) => !r.home);
  assert.equal((await send('DELETE', `/api/repos/${other.id}`)).status, 200);
  const home = (await send('GET', '/api/repos')).repos[0];
  assert.equal((await send('DELETE', `/api/repos/${home.id}`)).status, 400);
});
