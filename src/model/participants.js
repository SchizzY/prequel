// Humans and agents are the same kind of thing here: something that can author
// a comment, be assigned a thread, and be @mentioned. Replacing the old
// 'user' | 'claude' string with a row is what lets two agents coexist.

import os from 'node:os';

import { newId, plain, plainAll } from '../db/index.js';

// Distinguishable at a glance in the UI; assigned round-robin on creation.
const PALETTE = ['#0969da', '#8250df', '#bf3989', '#1a7f37', '#9a6700', '#cf222e'];

export function getByHandle(db, handle) {
  return plain(db.prepare('SELECT * FROM participant WHERE handle = ?').get(handle));
}

export function getParticipant(db, id) {
  return plain(db.prepare('SELECT * FROM participant WHERE id = ?').get(id));
}

export function listParticipants(db) {
  return plainAll(db.prepare('SELECT * FROM participant ORDER BY kind, handle').all());
}

/**
 * Idempotent by handle, so an agent can register itself on every run without
 * needing to know whether it has run here before.
 * `agentId` is the registry.json id ('claude-code', 'codex'); its presence is
 * what makes a participant an agent.
 */
export function ensureParticipant(db, { handle, displayName = null, agentId = null, color = null }) {
  const existing = getByHandle(db, handle);
  if (existing) return existing;
  const n = db.prepare('SELECT COUNT(*) AS n FROM participant').get().n;
  const row = {
    id: newId(),
    kind: agentId ? 'agent' : 'human',
    handle,
    display_name: displayName || handle,
    agent_id: agentId,
    color: color || PALETTE[n % PALETTE.length],
  };
  db.prepare(
    `INSERT INTO participant (id, kind, handle, display_name, agent_id, color)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.kind, row.handle, row.display_name, row.agent_id, row.color);
  return getByHandle(db, handle);
}

// "Cahill Eyte" -> "cahill-eyte": something typeable after an @.
export function toHandle(name) {
  const h = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return h || null;
}

/**
 * The person at the keyboard. The browser has no login, so whoever the store
 * already knows as a human is who the page posts as; a fresh store gets one
 * named after the git committer (falling back to the OS user) on first render.
 * Only agents self-register over the API, so nothing else would ever create
 * this row.
 */
export function currentHuman(db, { name = null } = {}) {
  const existing = plain(
    db.prepare("SELECT * FROM participant WHERE kind = 'human' ORDER BY created_at, handle LIMIT 1").get()
  );
  if (existing) return existing;
  let osUser = null;
  try {
    osUser = os.userInfo().username;
  } catch {
    /* no passwd entry */
  }
  const handle = toHandle(name) || toHandle(osUser) || 'user';
  return ensureParticipant(db, { handle, displayName: name || osUser || handle });
}
