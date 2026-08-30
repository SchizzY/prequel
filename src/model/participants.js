// Humans and agents are the same kind of thing here: something that can author
// a comment, be assigned a thread, and be @mentioned. Replacing the old
// 'user' | 'claude' string with a row is what lets two agents coexist.

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
