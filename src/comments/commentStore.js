// Central, per-repo comment persistence: ~/.prequel/<repo-hash>.json.
// Keeps the reviewed repo pristine (nothing to gitignore). Each comment is
// tagged with the branch it was written on. Writes are atomic (temp + rename).

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DIR = path.join(os.homedir(), '.prequel');

function fileFor(repoRoot) {
  const hash = crypto.createHash('sha1').update(repoRoot).digest('hex').slice(0, 16);
  return path.join(DIR, `${hash}.json`);
}

async function readAll(repoRoot) {
  try {
    const raw = await fs.readFile(fileFor(repoRoot), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.comments) ? data.comments : [];
  } catch {
    return [];
  }
}

async function writeAll(repoRoot, comments) {
  await fs.mkdir(DIR, { recursive: true });
  const dest = fileFor(repoRoot);
  const tmp = `${dest}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ repoRoot, comments }, null, 2));
  await fs.rename(tmp, dest);
}

export async function listComments(repoRoot, branch) {
  const all = await readAll(repoRoot);
  return branch ? all.filter((c) => c.branch === branch) : all;
}

export async function addComment(repoRoot, data) {
  const all = await readAll(repoRoot);
  const now = new Date().toISOString();
  const comment = {
    id: crypto.randomUUID(),
    repoRoot,
    createdAt: now,
    updatedAt: now,
    status: 'open',
    ...data,
  };
  all.push(comment);
  await writeAll(repoRoot, all);
  return comment;
}

export async function updateComment(repoRoot, id, patch) {
  const all = await readAll(repoRoot);
  const comment = all.find((c) => c.id === id);
  if (!comment) return null;
  Object.assign(comment, patch, { updatedAt: new Date().toISOString() });
  await writeAll(repoRoot, all);
  return comment;
}

export async function deleteComment(repoRoot, id) {
  const all = await readAll(repoRoot);
  const idx = all.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  all.splice(idx, 1);
  await writeAll(repoRoot, all);
  return true;
}

// In-memory buffer of the last bulk-clear, so the UI can offer a quick Undo.
const lastCleared = new Map();

export async function clearComments(repoRoot, branch) {
  const all = await readAll(repoRoot);
  const cleared = branch ? all.filter((c) => c.branch === branch) : all.slice();
  const kept = branch ? all.filter((c) => c.branch !== branch) : [];
  lastCleared.set(repoRoot, cleared);
  await writeAll(repoRoot, kept);
  return cleared.length;
}

export async function restoreCleared(repoRoot) {
  const cleared = lastCleared.get(repoRoot);
  if (!cleared || !cleared.length) return 0;
  const all = await readAll(repoRoot);
  all.push(...cleared);
  lastCleared.delete(repoRoot);
  await writeAll(repoRoot, all);
  return cleared.length;
}
