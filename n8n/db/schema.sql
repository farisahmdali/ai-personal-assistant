-- Browser activity → memory.
-- Run against the ai_assistant database. Safe to rerun.

-- ---------------------------------------------------------------------------
-- Temporary processing data. Deleted once an activity has become a memory.
-- ---------------------------------------------------------------------------

-- Latest semantic DOM tree and stable-id map per browser tab.
CREATE TABLE IF NOT EXISTS tmp_tab_state (
  tab_id      TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  tree        JSONB NOT NULL,
  id_map      JSONB NOT NULL,
  next_id     INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An activity: one tab on one website, closed after 5 min idle or 60 min.
CREATE TABLE IF NOT EXISTS tmp_activities (
  activity_id    TEXT PRIMARY KEY,
  tab_id         TEXT NOT NULL,
  website        TEXT NOT NULL,
  page_title     TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_event_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  claimed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tmp_activities_open_idx ON tmp_activities (tab_id, status);

CREATE TABLE IF NOT EXISTS tmp_activity_events (
  id           BIGSERIAL PRIMARY KEY,
  activity_id  TEXT NOT NULL REFERENCES tmp_activities (activity_id) ON DELETE CASCADE,
  at           TIMESTAMPTZ NOT NULL,
  kind         TEXT NOT NULL,
  text         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tmp_activity_events_activity_idx ON tmp_activity_events (activity_id, at);

-- ---------------------------------------------------------------------------
-- Permanent memory.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memories (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  activity_start  TIMESTAMPTZ NOT NULL,
  activity_end    TIMESTAMPTZ NOT NULL,
  website         TEXT,
  page_title      TEXT,
  memory_type     TEXT NOT NULL DEFAULT 'activity',
  summary         TEXT NOT NULL,
  details         JSONB NOT NULL DEFAULT '[]',
  entities        JSONB NOT NULL DEFAULT '[]',
  pending_task    TEXT,
  importance      REAL NOT NULL DEFAULT 0.5
);

CREATE INDEX IF NOT EXISTS memories_activity_start_idx ON memories (activity_start);
CREATE INDEX IF NOT EXISTS memories_entities_idx ON memories USING GIN (entities);
CREATE INDEX IF NOT EXISTS memories_pending_idx ON memories (activity_start) WHERE pending_task IS NOT NULL;

-- ===========================================================================
-- Computer and coding activity (Cursor extension, Cursor hooks, personal-monitor)
-- ===========================================================================

-- 1. Raw activity events, as delivered by personal-monitor. Short-lived:
--    deleted rawRetentionDays after they were summarised.
CREATE TABLE IF NOT EXISTS activity_events (
  event_id      TEXT PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL,
  source        TEXT NOT NULL,
  type          TEXT NOT NULL,
  project_root  TEXT,
  project_name  TEXT,
  session_id    TEXT,
  data          JSONB NOT NULL DEFAULT '{}',
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS activity_events_ts_idx ON activity_events (ts);
CREATE INDEX IF NOT EXISTS activity_events_unassigned_idx ON activity_events (project_root, ts) WHERE session_id IS NULL;
CREATE INDEX IF NOT EXISTS activity_events_session_idx ON activity_events (session_id, ts) WHERE processed_at IS NULL;

-- 2. Temporary working context: one work session per project, split by
--    inactivity. Closed sessions are deleted after 7 days.
CREATE TABLE IF NOT EXISTS work_sessions (
  session_id          TEXT PRIMARY KEY,
  project_root        TEXT NOT NULL,
  project_name        TEXT,
  started_at          TIMESTAMPTZ NOT NULL,
  last_event_at       TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'closed')),
  final               BOOLEAN NOT NULL DEFAULT false,
  last_summarized_at  TIMESTAMPTZ,
  memory_id           BIGINT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  claimed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS work_sessions_project_idx ON work_sessions (project_root, status);

-- 3. Long-term memory: coding tasks are stored in the same memories table.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS project            TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS project_root       TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS task_key           TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS session_id         TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS activity_type      TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS status             TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS files              JSONB;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS evidence           JSONB;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence         REAL;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS related_memory_id  BIGINT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS memories_project_idx ON memories (project_root, status) WHERE project_root IS NOT NULL;
