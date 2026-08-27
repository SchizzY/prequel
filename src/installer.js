// Installs prequel's agent integration. Targets are keyed by agent because
// each one wants a different artifact in a different place — Claude Code takes
// a skill under .claude/skills, others would take their own file.
//
// Installs go to the user's home directory by default rather than the reviewed
// repo, because prequel is run *against* other repos: a project-scoped skill
// wouldn't load in them.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Add an agent by adding a row here: where its artifact lives, and what the
// source file is.
const TARGETS = {
  claude: {
    label: 'Claude Code',
    source: path.resolve(__dirname, '..', 'skills', 'prequel', 'SKILL.md'),
    dir: path.join('.claude', 'skills', 'prequel'),
    file: 'SKILL.md',
  },
};

export const TARGET_NAMES = Object.keys(TARGETS);

export function targetPath(target, { project = false, cwd = process.cwd() } = {}) {
  const t = TARGETS[target];
  const base = project ? cwd : os.homedir();
  return path.join(base, t.dir, t.file);
}

async function readOrNull(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

// Returns { status, dest } where status is one of:
//   installed | updated | current | conflict
// `conflict` means the file on disk was edited; we refuse to clobber it
// without --force so local customizations aren't silently lost.
export async function install(target, { project = false, force = false, cwd = process.cwd() } = {}) {
  const t = TARGETS[target];
  if (!t) return { status: 'unknown-target', dest: null };
  const source = await fs.readFile(t.source, 'utf8');
  const dest = targetPath(target, { project, cwd });
  const existing = await readOrNull(dest);

  if (existing === source) return { status: 'current', dest };
  if (existing !== null && !force) return { status: 'conflict', dest };

  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, source);
  return { status: existing === null ? 'installed' : 'updated', dest };
}

// Names of installed integrations that no longer match the shipped copy —
// used to nudge after an upgrade. Never includes uninstalled targets.
export async function staleTargets() {
  const stale = [];
  for (const [name, t] of Object.entries(TARGETS)) {
    try {
      const existing = await readOrNull(targetPath(name));
      if (existing !== null && existing !== (await fs.readFile(t.source, 'utf8'))) stale.push(name);
    } catch {
      /* unreadable home dir — nothing to report */
    }
  }
  return stale;
}
