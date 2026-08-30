// Thin wrapper over the `git` CLI. All diffing is delegated to git so the
// output matches real PR semantics (rename detection, binary detection, etc.).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// Run git in a repo. `okCodes` lists non-zero exit codes to treat as success
// (git diff --no-index returns 1 when files differ, which is not an error).
function git(repoRoot, args, { okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // core.quotePath=false keeps non-ASCII paths literal instead of octal-escaped.
      ['-c', 'core.quotePath=false', '-C', repoRoot, ...args],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !okCodes.includes(err.code)) {
          reject(new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

export async function resolveRepoRoot(cwd) {
  try {
    const out = await git(cwd, ['rev-parse', '--show-toplevel']);
    return out.trim() || null;
  } catch {
    return null;
  }
}

// The committer identity, or null when git has none configured.
export async function getUserName(repoRoot) {
  try {
    const out = await git(repoRoot, ['config', 'user.name']);
    return out.trim() || null;
  } catch {
    return null;
  }
}

// Pick a sensible base ref: prefer main, then master, then origin's default.
export async function getDefaultBase(repoRoot) {
  const candidates = ['main', 'master'];
  for (const ref of candidates) {
    try {
      await git(repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
      return ref;
    } catch {
      /* not present */
    }
  }
  try {
    const out = await git(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const ref = out.trim();
    if (ref) return ref; // e.g. "origin/main"
  } catch {
    /* no origin HEAD */
  }
  return 'HEAD'; // last resort: diff against working tree only
}

// Refs offered by the base picker, grouped so the dropdown can keep local
// branches apart from remote-tracking ones, most recently committed first.
export async function listBranches(repoRoot) {
  const read = async (namespace) => {
    try {
      const out = await git(repoRoot, [
        'for-each-ref',
        // symref is non-empty only for aliases such as origin/HEAD, which point
        // at a branch already in the list — skip those. Note its short name is
        // just "origin", so there is no /HEAD suffix to match on.
        '--format=%(refname:short)%09%(symref)',
        '--sort=-committerdate',
        namespace,
      ]);
      return out
        .split('\n')
        .map((line) => line.split('\t').map((s) => s.trim()))
        .filter(([name, symref]) => name && !symref)
        .map(([name]) => name);
    } catch {
      return [];
    }
  };
  return { local: await read('refs/heads'), remote: await read('refs/remotes') };
}

// Current branch name, or a short SHA when detached.
export async function getHead(repoRoot) {
  const name = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (name && name !== 'HEAD') return name;
  const sha = (await git(repoRoot, ['rev-parse', '--short', 'HEAD'])).trim();
  return sha || 'HEAD';
}

async function mergeBase(repoRoot, base, head = 'HEAD') {
  try {
    return (await git(repoRoot, ['merge-base', base, head])).trim();
  } catch {
    return base; // base may not share history (e.g. HEAD sentinel) — diff directly
  }
}

/**
 * Which revision a pull request's head_ref actually names here.
 *
 * A PR you added from the picker can be about a branch this repo is not
 * standing on -- and now that pull requests come from several repos, that is
 * the common case rather than the exotic one. When the ref is checked out (or
 * unknown to git) 'HEAD' is used, so everything behaves exactly as it did when
 * a PR could only ever mean "this working copy".
 */
export async function resolveHeadRev(repoRoot, headRef) {
  if (!repoRoot || !headRef) return { rev: 'HEAD', ref: headRef || null, checkedOut: true };
  const current = await getHead(repoRoot).catch(() => null);
  if (!current || headRef === current) return { rev: 'HEAD', ref: headRef, checkedOut: true };
  const known = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${headRef}^{commit}`])
    .then(() => true)
    .catch(() => false);
  // An unresolvable ref (deleted branch, or a PR imported from elsewhere) falls
  // back to the checkout rather than rendering an error where a diff goes.
  return known ? { rev: headRef, ref: headRef, checkedOut: false } : { rev: 'HEAD', ref: current, checkedOut: true };
}

const DIFF_FLAGS = ['--no-color', '--find-renames', '--find-copies'];

// `extraFlags` shapes the output (nothing for patch text, --numstat for a
// summary); everything else about how an untracked file is diffed is the same.
async function untrackedDiff(repoRoot, extraFlags = []) {
  const listing = await git(repoRoot, ['ls-files', '--others', '--exclude-standard']);
  const files = listing.split('\n').map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  for (const file of files) {
    // --no-index synthesizes an "added file" patch; exit code 1 == differs.
    const chunk = await git(
      repoRoot,
      ['diff', ...DIFF_FLAGS, ...extraFlags, '--no-index', '--', '/dev/null', file],
      { okCodes: [0, 1] }
    );
    if (chunk) chunks.push(chunk);
  }
  return chunks.join('');
}

// Which revisions a mode compares, and whether untracked files belong to it.
// Shared, so the patch and the summary can never describe different things.
//
// `head` is the ref the comparison ends at. Only the checked-out branch has a
// working tree, so a PR about some other branch is always read as committed
// history -- working and all quietly become branch rather than showing this
// checkout's uncommitted edits under someone else's name.
async function diffRange(repoRoot, { base, mode, head }) {
  const headRev = await resolveHeadRev(repoRoot, head);
  const rev = headRev.rev;
  const effective = headRev.checkedOut ? mode : 'branch';
  const baseRef = base || (await getDefaultBase(repoRoot));
  const common = { baseRef, headRev: rev, headRef: headRev.ref, mode: effective };
  if (effective === 'working') return { ...common, revs: [rev], untracked: true };
  const mergeWith = await mergeBase(repoRoot, baseRef, rev);
  if (effective === 'branch') return { ...common, revs: [mergeWith, rev], untracked: false };
  return { ...common, revs: [mergeWith], untracked: true }; // all
}

/**
 * Produce the raw combined patch text for the requested mode.
 *  - branch:  committed changes on this branch vs base (closest to a real PR)
 *  - working: uncommitted changes (staged + unstaged) + untracked
 *  - all:     branch commits + working tree + untracked (default; superset)
 */
export async function getDiff(repoRoot, { base, mode = 'all', head = null } = {}) {
  const range = await diffRange(repoRoot, { base, mode, head });
  const { baseRef, revs, untracked } = range;

  let patch = await git(repoRoot, ['diff', ...DIFF_FLAGS, ...revs]);
  if (untracked) patch += await untrackedDiff(repoRoot);

  return {
    patch,
    head: range.headRef || (await getHead(repoRoot)),
    base: baseRef,
    mode: range.mode,
    // Which revision the new side came from, for context expansion and
    // re-anchoring: 'HEAD' for this checkout, otherwise the ref itself.
    rev: range.headRev,
  };
}

/**
 * Files changed and lines added/removed for the comparison getDiff would show,
 * without paying to parse the patch. The PR header's "+1,589 −53" reads this on
 * pages that never build the diff themselves.
 */
export async function getDiffStat(repoRoot, { base, mode = 'all', head = null } = {}) {
  const { baseRef, revs, untracked } = await diffRange(repoRoot, { base, mode, head });

  let numstat = await git(repoRoot, ['diff', ...DIFF_FLAGS, '--numstat', ...revs]);
  if (untracked) numstat += await untrackedDiff(repoRoot, ['--numstat']);

  const stat = { base: baseRef, files: 0, additions: 0, deletions: 0 };
  for (const line of numstat.split('\n')) {
    // Tab-separated columns: added, removed, path. Both counts are "-" for
    // a binary file, which Number() turns into 0 -- git cannot count its lines.
    const [added, removed, ...path] = line.split('\t');
    if (!path.length) continue;
    stat.files += 1;
    stat.additions += Number(added) || 0;
    stat.deletions += Number(removed) || 0;
  }
  return stat;
}

/**
 * The commits this pull request is made of, oldest first, the way a timeline
 * reads them. Fields are pipe-separated and the subject is everything left
 * over, so a subject containing a pipe cannot break the parse.
 */
export async function listCommits(repoRoot, { base, mode = 'branch', head = null } = {}) {
  const { revs, headRev } = await diffRange(repoRoot, { base, mode, head });
  const range = revs.length > 1 ? `${revs[0]}..${revs[1]}` : `${revs[0]}..${headRev}`;
  // An unresolvable range is a missing section, not a 500.
  const out = await git(repoRoot, ['log', '--reverse', '--format=%H|%h|%an|%aI|%s', range]).catch(
    () => ''
  );

  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, short, author, date, ...subject] = line.split('|');
      return { sha, short, author, date, subject: subject.join('|') };
    });
}

// Fetch a contiguous range of lines from a file for hunk-context expansion.
// rev === 'WORKTREE' reads the on-disk file (matches what's shown for
// all/working modes, including uncommitted edits); otherwise `git show rev:path`.
// start/end are 1-based inclusive. `eof` is true when `end` reached past the
// last line, so the caller can stop offering further downward expansion.
export async function getBlobLines(repoRoot, { rev, path: filePath, start, end }) {
  let content;
  if (rev === 'WORKTREE') {
    const abs = path.join(repoRoot, filePath);
    // guard against path traversal escaping the repo
    if (!abs.startsWith(path.resolve(repoRoot) + path.sep)) return { lines: [], eof: true };
    content = await fs.readFile(abs, 'utf8').catch(() => '');
  } else {
    content = await git(repoRoot, ['show', `${rev}:${filePath}`]).catch(() => '');
  }
  const all = content.split('\n');
  if (all.length && all[all.length - 1] === '') all.pop(); // drop trailing newline artifact
  const from = Math.max(1, start);
  const lines = all.slice(from - 1, end);
  return { lines, from, eof: end >= all.length };
}

// Whole-file contents as lines, for re-anchoring comments after the code moves.
// rev === 'WORKTREE' reads from disk (what all/working modes show); otherwise
// the blob at that revision.
export async function readFileLines(repoRoot, { rev, path: filePath }) {
  let content;
  if (rev === 'WORKTREE') {
    const abs = path.join(repoRoot, filePath);
    if (!abs.startsWith(path.resolve(repoRoot) + path.sep)) return null; // traversal guard
    content = await fs.readFile(abs, 'utf8').catch(() => null);
  } else {
    content = await git(repoRoot, ['show', `${rev}:${filePath}`]).catch(() => null);
  }
  if (content === null) return null; // file is gone at this revision
  const lines = content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Content hash of a file, so re-anchoring can skip files that have not changed
 * since a comment was written. Uses git's own object id, matching what the diff
 * machinery sees.
 */
export async function getBlobSha(repoRoot, { rev, path: filePath }) {
  if (rev === 'WORKTREE') {
    const abs = path.join(repoRoot, filePath);
    if (!abs.startsWith(path.resolve(repoRoot) + path.sep)) return null;
    const out = await git(repoRoot, ['hash-object', '--', abs]).catch(() => null);
    return out ? out.trim() : null;
  }
  const out = await git(repoRoot, ['rev-parse', `${rev}:${filePath}`]).catch(() => null);
  return out ? out.trim() : null;
}
