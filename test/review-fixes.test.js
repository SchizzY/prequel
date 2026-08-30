// Regressions for the defects the review pass turned up. Each test fails
// against the code as it was, so a fix that gets undone is caught here rather
// than in a browser or, worse, in someone's home directory.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import http from 'node:http';

import { createServer } from '../src/server.js';
import { getDiff, safeRef, readFileLines } from '../src/git/gitService.js';
import { relocate, reanchorPull } from '../src/anchor/reanchor.js';
import { renderMarkdown } from '../src/render/markdown.js';
import { openDb } from '../src/db/index.js';
import { createPull, deletePull, ensureRepo } from '../src/model/pulls.js';
import { ensureParticipant } from '../src/model/participants.js';
import { createThread, listThreads, inbox } from '../src/model/threads.js';

let base;
let server;
let repoDir;
let tmpRoots = [];

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-fix-'));
  tmpRoots.push(dir);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'app.js'), 'const a = 1;\nconst b = 2;\nconst dead = 3;\n');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  git('checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'app.js'), 'const a = 1;\nconst b = 3;\n');
  git('commit', '-qam', 'change b, drop dead');
  return dir;
}

const jsonPost = (url, body, headers = {}) =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

before(async () => {
  repoDir = makeRepo();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-fix-db-'));
  tmpRoots.push(dbDir);
  const app = createServer({ repoRoot: repoDir, dbPath: path.join(dbDir, 'prequel.db') });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

// --- git refs are refs, not options ---------------------------------------

test('a ref that is really a git option cannot reach the command line', async () => {
  assert.equal(safeRef('main'), 'main');
  assert.equal(safeRef('origin/main'), 'origin/main');
  assert.equal(safeRef('--output=/tmp/owned'), null);
  assert.equal(safeRef('-x'), null);
  assert.equal(safeRef('   '), null);
  assert.equal(safeRef('--output=x', 'main'), 'main');
});

test('?base=--output=… does not write a file', async () => {
  const target = path.join(os.tmpdir(), `prequel-owned-${Date.now()}.txt`);
  assert.equal(fs.existsSync(target), false);
  // The exact shape the security review exploited: a base ref that git reads
  // as --output and obediently writes the patch into.
  await getDiff(repoDir, { base: `--output=${target}`, mode: 'branch' });
  assert.equal(fs.existsSync(target), false, 'git must not have written the file');
});

test('the API refuses to store a ref that is an option', async () => {
  const res = await jsonPost('/api/pulls', {
    handle: 'cahill',
    title: 'sneaky',
    baseRef: '--output=/tmp/owned.txt',
    headRef: 'feature',
  });
  assert.equal(res.status, 400);
});

// --- cross-origin and rebinding -------------------------------------------

test('a cross-site form post is refused', async () => {
  const res = await jsonPost('/api/repos/pick', {}, { 'sec-fetch-site': 'cross-site' });
  assert.equal(res.status, 403);
});

test('a write carrying a foreign Origin is refused', async () => {
  const res = await jsonPost('/api/participants', { handle: 'evil' }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('a request for a rebound hostname is refused', async () => {
  // fetch() will not let a caller set Host, so this goes over a raw socket --
  // which is also how the attack would arrive.
  const { port } = server.address();
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/healthz', method: 'GET', headers: { host: 'attacker.example' } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('the pages themselves still load', async () => {
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
});

// --- markdown cannot execute ----------------------------------------------

test('markdown bodies cannot carry script', () => {
  assert.match(renderMarkdown('<img src=x onerror=alert(1)>'), /&lt;img/);
  assert.doesNotMatch(renderMarkdown('<img src=x onerror=alert(1)>'), /<img/);
  assert.doesNotMatch(renderMarkdown('[click](javascript:alert(1))'), /javascript:/);
  assert.doesNotMatch(renderMarkdown('[click](java&#9;script:alert(1))'), /script:/);
  // ordinary markdown still works
  assert.match(renderMarkdown('**bold**'), /<strong>bold<\/strong>/);
  assert.match(renderMarkdown('[ok](https://example.com)'), /href="https:\/\/example\.com"/);
});

// --- anchoring -------------------------------------------------------------

test('a thread without a snapshot keeps the range it was filed with', () => {
  const lines = ['a', 'b', 'c', 'd', 'e'];
  const result = relocate(lines, null, 2, 4);
  assert.equal(result.startLine, 2);
  assert.equal(result.endLine, 4, 'a comment on lines 2-4 must not collapse to line 2');
});

test('a lost thread keeps its range too', () => {
  const result = relocate(null, ['gone'], 10, 20);
  assert.equal(result.anchorState, 'lost');
  assert.equal(result.endLine, 20);
});

test('worktree lines are compared free of CRLF', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-crlf-'));
  tmpRoots.push(dir);
  execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'f.txt'), 'alpha\r\nbeta\r\ngamma\r\n');
  const lines = await readFileLines(dir, { rev: 'WORKTREE', path: 'f.txt' });
  assert.deepEqual(lines, ['alpha', 'beta', 'gamma']);
});

test('an old-side comment on deleted code is not re-anchored against the new file', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-old-'));
  tmpRoots.push(dbDir);
  const db = openDb(path.join(dbDir, 'prequel.db'));
  const repo = ensureRepo(db, repoDir);
  const who = ensureParticipant(db, { handle: 'claude', agentId: 'claude-code' });
  const pull = createPull(db, {
    repoId: repo.id,
    title: 'p',
    authorId: who.id,
    baseRef: 'main',
    headRef: 'feature',
  });
  // "why did you delete this?" — the snapshot is code that is gone from the new
  // file by definition, which is exactly why it must not be looked for there.
  createThread(db, {
    pullRequestId: pull.id,
    participantId: who.id,
    filePath: 'app.js',
    side: 'old',
    startLine: 3,
    endLine: 3,
    lineSnapshot: ['const dead = 3;'],
    body: 'why was this removed?',
  });
  await reanchorPull(db, { repoRoot: repoDir, pullRequestId: pull.id, rev: 'WORKTREE' });
  const [thread] = listThreads(db, pull.id);
  assert.notEqual(thread.anchor_state, 'lost', 'an old-side comment must survive its own deletion');
  assert.equal(thread.start_line, 3, 'and must keep its old-side line number');
  db.close();
});

test('reading another revision cannot bury a thread as lost', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-lost-'));
  tmpRoots.push(dbDir);
  const db = openDb(path.join(dbDir, 'prequel.db'));
  const repo = ensureRepo(db, repoDir);
  const who = ensureParticipant(db, { handle: 'claude', agentId: 'claude-code' });
  const pull = createPull(db, {
    repoId: repo.id,
    title: 'p',
    authorId: who.id,
    baseRef: 'main',
    headRef: 'feature',
  });
  createThread(db, {
    pullRequestId: pull.id,
    participantId: who.id,
    filePath: 'app.js',
    side: 'new',
    startLine: 1,
    endLine: 1,
    lineSnapshot: ['this text is in no revision at all'],
    body: 'a finding on uncommitted work',
  });
  const before = listThreads(db, pull.id)[0];
  await reanchorPull(db, {
    repoRoot: repoDir,
    pullRequestId: pull.id,
    rev: 'HEAD',
    persist: false,
  });
  const [thread] = listThreads(db, pull.id);
  assert.notEqual(thread.anchor_state, 'lost');
  // Nor may a foreign revision quietly rewrite the line number.
  assert.equal(thread.start_line, before.start_line);
  db.close();
});

// --- mentions --------------------------------------------------------------

test('a mention at the end of a sentence is delivered', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-mention-'));
  tmpRoots.push(dbDir);
  const db = openDb(path.join(dbDir, 'prequel.db'));
  const repo = ensureRepo(db, repoDir);
  const author = ensureParticipant(db, { handle: 'cahill', displayName: 'Cahill' });
  const claude = ensureParticipant(db, { handle: 'claude', agentId: 'claude-code' });
  const pull = createPull(db, {
    repoId: repo.id,
    title: 'p',
    authorId: author.id,
    baseRef: 'main',
    headRef: 'feature',
  });
  createThread(db, {
    pullRequestId: pull.id,
    participantId: author.id,
    body: 'Fixed, over to you @claude.',
  });
  assert.equal(inbox(db, claude.id).length, 1, 'a trailing full stop is punctuation, not a handle');
  db.close();
});

// --- pull request numbers --------------------------------------------------

test('a deleted PR does not hand its number to the next one', () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-num-'));
  tmpRoots.push(dbDir);
  const db = openDb(path.join(dbDir, 'prequel.db'));
  const repo = ensureRepo(db, repoDir);
  const who = ensureParticipant(db, { handle: 'cahill' });
  const mk = (title) =>
    createPull(db, { repoId: repo.id, title, authorId: who.id, baseRef: 'main', headRef: 'feature' });

  const first = mk('one');
  const second = mk('two');
  assert.equal(first.number, 1);
  assert.equal(second.number, 2);
  deletePull(db, second.id);
  const third = mk('three');
  assert.equal(third.number, 3, '/pr/2 must not start meaning a different pull request');
  db.close();
});

// --- the Files tab actually shows the review ------------------------------

test('the Files tab carries the threads filed against it', async () => {
  await jsonPost('/api/participants', { handle: 'cahill', displayName: 'Cahill' });
  await jsonPost('/api/participants', { handle: 'claude', agentId: 'claude-code' });
  const { pull } = await (
    await jsonPost('/api/pulls', {
      handle: 'cahill',
      title: 'Change b',
      baseRef: 'main',
      headRef: 'feature',
    })
  ).json();
  await jsonPost(`/api/pulls/${pull.number}/threads`, {
    handle: 'claude',
    filePath: 'app.js',
    side: 'new',
    startLine: 2,
    endLine: 2,
    severity: 'blocking',
    body: 'this constant needs a name',
  });

  const html = await (await fetch(`${base}/pr/${pull.number}/files?live=0`)).text();
  // The findings reach the page rather than being computed and dropped.
  assert.match(html, /id="pr-threads"/);
  assert.match(html, /this constant needs a name/);
  assert.match(html, /blocking/);
  // And the page identifies the reviewer, so replies address the thread store.
  assert.match(html, /data-me="cahill"/);
  assert.match(html, /data-pr="1"/);
});

test('a review body renders as itself, not as the reviewer previous round', async () => {
  const number = 1;
  const round = async (body, verdict) => {
    const { review } = await (await jsonPost(`/api/pulls/${number}/reviews`, { handle: 'claude' })).json();
    await jsonPost(`/api/reviews/${review.id}/submit`, { body, verdict });
    return review;
  };
  await round('ROUND ONE BODY', 'request_changes');
  await round('ROUND TWO BODY', 'approve');

  const html = await (await fetch(`${base}/pr/${number}?live=0`)).text();
  assert.match(html, /ROUND ONE BODY/);
  assert.match(html, /ROUND TWO BODY/, 'the second round must render its own body');
  assert.match(html, /approved these changes/);
});

// --- second round: what the informed review turned up ---------------------

test('an inline <code> tag cannot switch marked into raw mode', () => {
  // marked sets `inRawBlock` on an inline <code>/<pre>/<kbd>/<script> and from
  // then on emits raw source through the text renderer, which the html
  // renderer never sees. Escaping at the renderer alone missed all of this.
  const payloads = [
    'a <code> b <img/src=q/onerror=alert(1)>',
    'x <kbd> y <svg/onload=alert(1)>',
    'see <pre> then <div/onmouseover=alert(1)>hi</div>',
    '<script>alert(1)</script>',
    '[a](<https://e.com/" onmouseover="alert(1)>)',
    '![i](<https://e.com/" onerror="alert(1)>)',
  ];
  const allowed = new Set([
    'p','a','img','strong','em','code','pre','ul','ol','li','blockquote','br',
    'h1','h2','h3','h4','h5','h6','table','thead','tbody','tr','th','td','del','hr',
  ]);
  for (const payload of payloads) {
    const html = renderMarkdown(payload);
    for (const tag of html.match(/<[a-zA-Z][^>]*>/g) || []) {
      const name = tag.match(/^<([a-zA-Z0-9]+)/)[1].toLowerCase();
      assert.ok(allowed.has(name), `${payload} produced <${name}>`);
      // An event handler surviving outside a quoted attribute value.
      const bare = tag.replace(/="[^"]*"/g, '=X').replace(/='[^']*'/g, '=X');
      assert.doesNotMatch(bare, /\son[a-z]+\s*=/i, `${payload} produced a handler: ${tag}`);
    }
  }
});

test('markdown still renders code and links correctly', () => {
  assert.match(renderMarkdown('```js\nif (a < b) return;\n```'), /if \(a &lt; b\) return;/);
  assert.doesNotMatch(renderMarkdown('```js\nif (a < b) return;\n```'), /&amp;lt;/);
  // `&` in an href is escaped, so the browser reads the query string literally
  // rather than decoding an entity-shaped parameter such as `&sect;`.
  assert.match(renderMarkdown('[a](https://e.com?x=1&y=2)'), /x=1&amp;y=2/);
  assert.match(renderMarkdown('[a](https://e.com/?x=1&sect;y=2)'), /x=1&amp;sect;y=2/);
  // A title is escaped once, by marked, and not again here.
  assert.match(renderMarkdown('[a](https://e.com "ti&tle")'), /title="ti&amp;tle"/);
});

test('an entity-encoded colon cannot smuggle a javascript: URL through', () => {
  // Entities are decoded before the scheme is judged, not deleted: deleting
  // them takes the colon with it, the value looks like a relative URL, and the
  // browser then decodes it back into a working javascript: link.
  for (const payload of [
    '[c](javascript&#58;alert(1))',
    '[c](javascript&#x3a;alert(1))',
    '[c](javascript&colon;alert(1))',
    '[c](vbscript&colon;msgbox(1))',
    '[c](JaVaScRiPt&#58;alert(1))',
    '[c][r]\n\n[r]: javascript&colon;alert(1)',
  ]) {
    assert.doesNotMatch(renderMarkdown(payload), /href="[^"]*(javascript|vbscript)/i, payload);
  }
  // and the safe ones still work
  assert.match(renderMarkdown('[a](https://e.com)'), /href="https:/);
  assert.match(renderMarkdown('[a](mailto:x@y.z)'), /href="mailto:/);
  assert.match(renderMarkdown('[a](/pr/1/files)'), /href="\/pr\/1\/files"/);
});

test('a cross-site write is refused even without an Origin header', async () => {
  const res = await fetch(base + '/api/participants', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    },
    body: JSON.stringify({ handle: 'evil' }),
  });
  assert.equal(res.status, 403);
});

test('a refused request still carries the security headers', async () => {
  const res = await fetch(base + '/healthz', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' } });
  assert.equal(res.status, 403);
  assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
});

test('the pages carry a content security policy and refuse to be framed', async () => {
  const res = await fetch(base + '/healthz');
  assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.match(res.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('a cross-site iframe cannot drive a state-changing GET', async () => {
  const res = await fetch(base + '/healthz', {
    headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
  });
  assert.equal(res.status, 403);
});

test('the user following a link from another site is still allowed', async () => {
  const res = await fetch(base + '/healthz', {
    headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
  });
  assert.equal(res.status, 200);
});

test('a range keeps its width when the snapshot is shorter than the range', () => {
  const lines = ['pad', 'x', 'target', 'a', 'b', 'c', 'd', 'e'];
  // Filed on lines 2-6, but only one line of snapshot was captured.
  const result = relocate(lines, ['target'], 2, 6);
  assert.equal(result.endLine - result.startLine, 4, 'the reviewer range must survive');
});

test('threads come back from the API with their markdown rendered', async () => {
  const { pull } = await (
    await jsonPost('/api/pulls', {
      handle: 'cahill',
      title: 'md',
      baseRef: 'main',
      headRef: 'feature',
    })
  ).json();
  await jsonPost(`/api/pulls/${pull.number}/threads`, {
    handle: 'claude',
    filePath: 'app.js',
    side: 'new',
    startLine: 1,
    endLine: 1,
    body: '**bold** finding',
  });
  const { threads: list } = await (
    await fetch(`${base}/api/pulls/${pull.number}/threads?anchored=1`)
  ).json();
  assert.match(list[0].comments[0].bodyHtml, /<strong>bold<\/strong>/);
});

test('an assignment names who assigned it and to whom', async () => {
  const { pull } = await (
    await jsonPost('/api/pulls', {
      handle: 'cahill',
      title: 'assign',
      baseRef: 'main',
      headRef: 'feature',
    })
  ).json();
  await jsonPost('/api/participants', { handle: 'codex', agentId: 'codex' });
  const { thread } = await (
    await jsonPost(`/api/pulls/${pull.number}/threads`, {
      handle: 'claude',
      filePath: 'app.js',
      side: 'new',
      startLine: 1,
      endLine: 1,
      body: 'needs an owner',
    })
  ).json();
  await fetch(`${base}/api/threads/${thread.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assignee: 'codex', handle: 'claude' }),
  });
  const { timeline } = await (await fetch(`${base}/api/pulls/${pull.number}/timeline`)).json();
  const event = timeline.find((e) => e.kind === 'thread_assigned');
  assert.ok(event, 'the assignment is on the timeline');
  assert.equal(event.handle, 'claude', 'the actor is the assigner, not the assignee');
  assert.equal(event.payload.assignee, 'codex');
});

// --- third round: what the final verification turned up -------------------

test('a range that outlives its file is clamped to the file', () => {
  const lines = ['a', 'target', 'c'];
  // Filed on 5-25; the PR truncated the file to 3 lines.
  const result = relocate(lines, ['target'], 5, 25);
  assert.equal(result.startLine, 2);
  assert.ok(result.endLine <= lines.length, `end ${result.endLine} must be inside a ${lines.length}-line file`);
});

test('an old-side thread is not buried when the base cannot be read', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prequel-base-'));
  tmpRoots.push(dbDir);
  const db = openDb(path.join(dbDir, 'prequel.db'));
  const repo = ensureRepo(db, repoDir);
  const who = ensureParticipant(db, { handle: 'claude', agentId: 'claude-code' });
  const pull = createPull(db, {
    repoId: repo.id,
    title: 'p',
    authorId: who.id,
    baseRef: 'main',
    headRef: 'feature',
  });
  createThread(db, {
    pullRequestId: pull.id,
    participantId: who.id,
    filePath: 'renamed-away.js', // no such path at the base revision
    side: 'old',
    startLine: 3,
    endLine: 3,
    lineSnapshot: ['const dead = 3;'],
    body: 'why was this removed?',
  });
  // A base revision that exists, but a file that does not exist in it: the
  // renamed-file and unfetched-base cases both look like this.
  await reanchorPull(db, {
    repoRoot: repoDir,
    pullRequestId: pull.id,
    rev: 'WORKTREE',
    baseRev: 'main',
  });
  const [thread] = listThreads(db, pull.id);
  assert.notEqual(
    thread.anchor_state,
    'lost',
    'an unreadable base says nothing about the thread, and must not drop it from the work queue'
  );
  db.close();
});

test('the old side re-anchors against the merge base, not the base tip', async () => {
  const { resolveBaseRev } = await import('../src/git/gitService.js');
  const merged = await resolveBaseRev(repoDir, 'main', 'feature');
  const tip = execFileSync('git', ['-C', repoDir, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  const expected = execFileSync('git', ['-C', repoDir, 'merge-base', 'main', 'feature'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(merged, expected);
  assert.equal(merged, tip, 'main has not moved on in this fixture, so the two agree here');
  // An unresolvable base is null, so callers leave old-side threads alone.
  assert.equal(await resolveBaseRev(repoDir, 'no-such-branch', 'feature'), null);
  assert.equal(await resolveBaseRev(repoDir, null, 'feature'), null);
});

test('a legacy assignment event is not rendered as an unassignment', async () => {
  // Events written before the payload carried an assignee have only a threadId.
  const { pull } = await (
    await jsonPost('/api/pulls', {
      handle: 'cahill',
      title: 'legacy assign',
      baseRef: 'main',
      headRef: 'feature',
    })
  ).json();
  const { thread } = await (
    await jsonPost(`/api/pulls/${pull.number}/threads`, {
      handle: 'claude',
      filePath: 'app.js',
      side: 'new',
      startLine: 1,
      endLine: 1,
      body: 'legacy',
    })
  ).json();
  await fetch(`${base}/api/threads/${thread.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assignee: 'codex', handle: 'claude' }),
  });
  const html = await (await fetch(`${base}/pr/${pull.number}?live=0`)).text();
  assert.match(html, /assigned a finding on/);
  assert.doesNotMatch(html, /unassigned a finding on/);
});
