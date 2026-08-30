-- Schema for the multi-reviewer review app.
--
-- Three ideas the original single-agent store conflated, now separate:
--   author    (who wrote it)      -> comment.participant_id
--   addressee (who acts on it)    -> thread.assignee_id
--   batch     (one review round)  -> review
--
-- Anchors and lifecycle live on `thread`, not on a root comment, so threads
-- nest arbitrarily deep and there is exactly one place to record status,
-- severity and anchor drift.

CREATE TABLE repo (
  id          TEXT PRIMARY KEY,
  root_path   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Humans and agents, uniformly. `handle` is what you @mention.
CREATE TABLE participant (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('human','agent')),
  handle        TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  agent_id      TEXT,                 -- registry.json agent id; NULL for humans
  color         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((kind = 'agent') = (agent_id IS NOT NULL))
);

CREATE TABLE pull_request (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  number        INTEGER NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  author_id     TEXT NOT NULL REFERENCES participant(id),
  base_ref      TEXT NOT NULL,
  head_ref      TEXT NOT NULL,
  base_sha      TEXT,
  head_sha      TEXT,
  diff_mode     TEXT NOT NULL DEFAULT 'branch'
                  CHECK (diff_mode IN ('all','branch','working')),
  worktree_path TEXT,
  state         TEXT NOT NULL DEFAULT 'open'
                  CHECK (state IN ('draft','open','merged','closed')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (repo_id, number)
);

-- A batch of findings submitted as one unit. `body` is the narrative that
-- keeps 40 inline comments from reading as 40 unrelated interruptions.
CREATE TABLE review (
  id              TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,
  participant_id  TEXT NOT NULL REFERENCES participant(id),
  body            TEXT NOT NULL DEFAULT '',
  verdict         TEXT CHECK (verdict IN ('approve','request_changes','comment')),
  state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending','submitted')),
  head_sha        TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  submitted_at    TEXT,
  CHECK (state = 'pending' OR verdict IS NOT NULL)
);

-- One draft per reviewer per PR.
CREATE UNIQUE INDEX review_one_pending
  ON review (pull_request_id, participant_id) WHERE state = 'pending';

CREATE TABLE thread (
  id              TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,

  -- Anchor. All-NULL means conversation-level (the PR-wide comment).
  file_path       TEXT,
  side            TEXT CHECK (side IN ('old','new','file')),
  start_line      INTEGER,
  end_line        INTEGER,
  blob_sha        TEXT,
  line_snapshot   TEXT,          -- JSON array of the code as written
  anchor_state    TEXT NOT NULL DEFAULT 'current'
                    CHECK (anchor_state IN ('current','outdated','lost')),

  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','resolved')),
  severity        TEXT CHECK (severity IN ('blocking','suggestion','nit','question')),
  category        TEXT,
  assignee_id     TEXT REFERENCES participant(id),
  resolved_by_id  TEXT REFERENCES participant(id),
  resolved_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((file_path IS NULL) = (side IS NULL))
);

-- Flat, ordered, arbitrarily deep. No parent_id.
CREATE TABLE comment (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  review_id      TEXT REFERENCES review(id) ON DELETE SET NULL,
  participant_id TEXT NOT NULL REFERENCES participant(id),
  body           TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  legacy_id      TEXT,          -- id in the pre-SQLite JSON store, if imported
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at     TEXT,
  UNIQUE (thread_id, seq)
);

-- Makes importing a legacy store idempotent: a second run cannot re-insert a
-- comment it already brought across.
CREATE UNIQUE INDEX comment_legacy ON comment (legacy_id) WHERE legacy_id IS NOT NULL;

-- How the triage pass records dedup and disagreement across reviewers.
CREATE TABLE thread_link (
  from_thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  to_thread_id   TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('duplicate_of','related_to','contradicts')),
  created_by_id  TEXT REFERENCES participant(id),
  PRIMARY KEY (from_thread_id, to_thread_id, kind)
);

CREATE TABLE timeline_event (
  id              TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,
  participant_id  TEXT REFERENCES participant(id),
  kind            TEXT NOT NULL,
  payload         TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- How agent B learns agent A replied.
CREATE TABLE mention (
  comment_id     TEXT NOT NULL REFERENCES comment(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participant(id) ON DELETE CASCADE,
  seen_at        TEXT,
  PRIMARY KEY (comment_id, participant_id)
);

CREATE TABLE file_view (
  pull_request_id TEXT NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,
  participant_id  TEXT NOT NULL REFERENCES participant(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  viewed_at_sha   TEXT,
  viewed_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (pull_request_id, participant_id, file_path)
);

CREATE INDEX thread_by_file    ON thread (pull_request_id, file_path, start_line);
CREATE INDEX thread_queue      ON thread (assignee_id, status) WHERE status = 'open';
CREATE INDEX comment_by_thread ON comment (thread_id, seq);
CREATE INDEX review_by_pr      ON review (pull_request_id, state);
CREATE INDEX timeline_by_pr    ON timeline_event (pull_request_id, created_at);
CREATE INDEX mention_inbox     ON mention (participant_id) WHERE seen_at IS NULL;
