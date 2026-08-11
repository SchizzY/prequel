#!/usr/bin/env node
import { createServer as createNetServer } from 'node:net';
import process from 'node:process';
import open from 'open';
import { createServer } from '../src/server.js';
import { resolveRepoRoot } from '../src/git/gitService.js';

// --- tiny arg parser (avoid a dependency for Phase 0) --------------------
function parseArgs(argv) {
  const opts = { repoPath: process.cwd(), base: null, port: null, open: true };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') opts.base = argv[++i];
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--no-open') opts.open = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('-')) positional.push(a);
  }
  if (positional[0]) opts.repoPath = positional[0];
  return opts;
}

const HELP = `prequel — local GitHub-style PR diff reviewer

Usage:
  prequel [repoPath] [--base <ref>] [--port <n>] [--no-open]

  repoPath   Path to the git repo (default: current directory)
  --base     Base ref to diff against (default: main/master)
  --port     Port to listen on (default: first free from 4711)
  --no-open  Don't auto-open the browser
`;

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once('error', () => {
      // port in use — try the next one
      findFreePort(start + 1).then(resolve, reject);
    });
    srv.once('listening', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.listen(start, '127.0.0.1');
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const repoRoot = await resolveRepoRoot(opts.repoPath);
  // A non-repo is tolerated: the server falls back to the built-in sample diff.
  const effectiveRepo = repoRoot || opts.repoPath;

  const app = createServer({ repoRoot, defaultBase: opts.base });
  const port = opts.port || (await findFreePort(4711));

  app.listen(port, '127.0.0.1', async () => {
    const url = `http://127.0.0.1:${port}`;
    process.stdout.write(`\n  prequel running at ${url}\n`);
    process.stdout.write(`  repo: ${effectiveRepo}${repoRoot ? '' : '  (not a git repo — showing sample diff)'}\n`);
    process.stdout.write('  Ctrl-C to stop\n\n');
    if (opts.open) {
      try {
        await open(url);
      } catch {
        /* headless / no browser — ignore */
      }
    }
  });
}

main().catch((err) => {
  process.stderr.write(`prequel failed to start: ${err.message}\n`);
  process.exit(1);
});
