/**
 * Schema is applied on every open; every statement is idempotent. `user_version`
 * carries the migration number so later releases can add ALTERs behind it.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  seq               INTEGER NOT NULL,
  project           TEXT NOT NULL,
  cwd               TEXT,
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  end_reason        TEXT,
  transcript_path   TEXT,
  observation_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS sessions_project_started
  ON sessions (project, started_at DESC);

CREATE TABLE IF NOT EXISTS observations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  project      TEXT NOT NULL,
  type         TEXT NOT NULL,
  agent        TEXT NOT NULL DEFAULT 'claude',
  scope        TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL,
  narrative    TEXT NOT NULL DEFAULT '',
  facts        TEXT NOT NULL DEFAULT '[]',
  files        TEXT NOT NULL DEFAULT '[]',
  keywords     TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS observations_project_created
  ON observations (project, created_at DESC);
CREATE INDEX IF NOT EXISTS observations_session
  ON observations (session_id);

-- External-content FTS index: the row data lives in the observations table,
-- the index only holds the terms, and the triggers below keep the two in step.
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5 (
  title,
  narrative,
  facts,
  keywords,
  files,
  scope,
  content = 'observations',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts (rowid, title, narrative, facts, keywords, files, scope)
  VALUES (new.id, new.title, new.narrative, new.facts, new.keywords, new.files, new.scope);
END;

CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts (observations_fts, rowid, title, narrative, facts, keywords, files, scope)
  VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.keywords, old.files, old.scope);
END;

CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts (observations_fts, rowid, title, narrative, facts, keywords, files, scope)
  VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.keywords, old.files, old.scope);
  INSERT INTO observations_fts (rowid, title, narrative, facts, keywords, files, scope)
  VALUES (new.id, new.title, new.narrative, new.facts, new.keywords, new.files, new.scope);
END;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
