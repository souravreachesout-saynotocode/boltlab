import { createHash } from 'node:crypto';
import type { Db } from './index.js';
import { queryAll, queryOne, transact } from './index.js';
import type { Observation, ObservationInput, SessionRecord } from '../types.js';
import { OBSERVATION_TYPES } from '../types.js';

interface ObservationRow {
  id: number;
  session_id: string;
  session_seq: number;
  seq: number;
  project: string;
  type: string;
  agent: string;
  scope: string;
  title: string;
  narrative: string;
  facts: string;
  files: string;
  keywords: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  seq: number;
  project: string;
  cwd: string | null;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  transcript_path: string | null;
  observation_count: number;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionSeq: row.session_seq,
    seq: row.seq,
    project: row.project,
    type: (OBSERVATION_TYPES as readonly string[]).includes(row.type)
      ? (row.type as Observation['type'])
      : 'discovery',
    agent: row.agent,
    scope: row.scope,
    title: row.title,
    narrative: row.narrative,
    facts: parseJsonArray(row.facts),
    files: parseJsonArray(row.files),
    keywords: row.keywords ? row.keywords.split(/\s+/).filter(Boolean) : [],
    createdAt: row.created_at,
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    seq: row.seq,
    project: row.project,
    cwd: row.cwd,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    transcriptPath: row.transcript_path,
    observationCount: row.observation_count,
  };
}

const OBSERVATION_COLUMNS = `
  o.id, o.session_id, o.seq, o.project, o.type, o.agent, o.scope,
  o.title, o.narrative, o.facts, o.files, o.keywords, o.created_at,
  s.seq AS session_seq
`;

/** Observations always carry their session's number, so the join is not optional. */
const OBSERVATION_FROM = 'FROM observations o JOIN sessions s ON s.id = o.session_id';

/** Records a session the first time it is seen; later calls only fill in gaps. */
export function ensureSession(
  db: Db,
  session: { id: string; project: string; cwd?: string | null; transcriptPath?: string | null; startedAt?: string },
): SessionRecord {
  const existing = queryOne<SessionRow>(db, 'SELECT * FROM sessions WHERE id = ?', session.id);

  if (existing) {
    db.prepare(
      `UPDATE sessions
          SET cwd = COALESCE(?, cwd),
              transcript_path = COALESCE(?, transcript_path)
        WHERE id = ?`,
    ).run(session.cwd ?? null, session.transcriptPath ?? null, session.id);
    return toSession(queryOne<SessionRow>(db, 'SELECT * FROM sessions WHERE id = ?', session.id)!);
  }

  const { next } = queryOne<{ next: number }>(
    db,
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM sessions WHERE project = ?',
    session.project,
  )!;

  db.prepare(
    `INSERT INTO sessions (id, seq, project, cwd, started_at, transcript_path)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    next,
    session.project,
    session.cwd ?? null,
    session.startedAt ?? new Date().toISOString(),
    session.transcriptPath ?? null,
  );

  return toSession(queryOne<SessionRow>(db, 'SELECT * FROM sessions WHERE id = ?', session.id)!);
}

export function finishSession(
  db: Db,
  sessionId: string,
  reason: string | null,
  endedAt?: string,
): void {
  db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?').run(
    endedAt ?? new Date().toISOString(),
    reason,
    sessionId,
  );
}

/** How many observations a session already has. Backfill uses it to skip work. */
export function observationCount(db: Db, sessionId: string): number {
  return (
    queryOne<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM observations WHERE session_id = ?',
      sessionId,
    )?.count ?? 0
  );
}

/**
 * Stable identity for an observation: the same session re-extracted (after a
 * compact, say) re-derives the same hash and is ignored rather than duplicated.
 */
export function contentHash(sessionId: string, input: ObservationInput): string {
  return createHash('sha256')
    .update(sessionId)
    .update('\u0000')
    .update(input.title.trim().toLowerCase())
    .update('\u0000')
    .update(input.type)
    .digest('hex');
}

export interface InsertResult {
  inserted: Observation[];
  skipped: number;
}

/** Writes a batch of extracted observations, skipping ones already stored. */
export function insertObservations(
  db: Db,
  args: { sessionId: string; project: string; agent?: string; createdAt?: string },
  inputs: ObservationInput[],
): InsertResult {
  const agent = args.agent ?? 'claude';
  const createdAt = args.createdAt ?? new Date().toISOString();

  return transact(db, () => {
    const inserted: Observation[] = [];
    let skipped = 0;

    for (const input of inputs) {
      const hash = contentHash(args.sessionId, input);
      const duplicate = queryOne<{ hit: number }>(
        db,
        'SELECT 1 AS hit FROM observations WHERE content_hash = ?',
        hash,
      );
      if (duplicate) {
        skipped += 1;
        continue;
      }

      const { next } = queryOne<{ next: number }>(
        db,
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM observations',
      )!;

      const info = db
        .prepare(
          `INSERT INTO observations
             (session_id, seq, project, type, agent, scope, title, narrative,
              facts, files, keywords, created_at, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.sessionId,
          next,
          args.project,
          input.type,
          agent,
          input.scope ?? '',
          input.title,
          input.narrative,
          JSON.stringify(input.facts ?? []),
          JSON.stringify(input.files ?? []),
          (input.keywords ?? []).join(' '),
          createdAt,
          hash,
        );

      const row = queryOne<ObservationRow>(
        db,
        `SELECT ${OBSERVATION_COLUMNS} ${OBSERVATION_FROM} WHERE o.id = ?`,
        Number(info.lastInsertRowid),
      )!;
      inserted.push(toObservation(row));
    }

    db.prepare(
      `UPDATE sessions
          SET observation_count = (SELECT COUNT(*) FROM observations WHERE session_id = ?)
        WHERE id = ?`,
    ).run(args.sessionId, args.sessionId);

    return { inserted, skipped };
  });
}

export interface ListOptions {
  project?: string | null;
  type?: string | null;
  sessionId?: string | null;
  limit?: number;
  /** Cursor: return observations with an id strictly below this one. */
  before?: number | null;
}

export function listObservations(db: Db, options: ListOptions = {}): Observation[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (options.project) {
    where.push('o.project = ?');
    params.push(options.project);
  }
  if (options.type) {
    where.push('o.type = ?');
    params.push(options.type);
  }
  if (options.sessionId) {
    where.push('o.session_id = ?');
    params.push(options.sessionId);
  }
  if (options.before) {
    where.push('o.id < ?');
    params.push(options.before);
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const sql = `SELECT ${OBSERVATION_COLUMNS} ${OBSERVATION_FROM}
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY o.id DESC
               LIMIT ?`;
  return queryAll<ObservationRow>(db, sql, ...params, limit).map(toObservation);
}

/**
 * Turns free text into an FTS5 MATCH expression. Every token is quoted, so
 * punctuation in a user query can never be read as FTS syntax; the last token
 * also gets a prefix match so partial words still hit while typing.
 */
export function toMatchExpression(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 1);
  if (tokens.length === 0) return null;

  const terms = tokens.map((token, index) =>
    index === tokens.length - 1 ? `"${token}"*` : `"${token}"`,
  );
  // Phrase first so an exact run of words outranks the same words scattered.
  const phrase = tokens.length > 1 ? [`"${tokens.join(' ')}"`] : [];
  return [...phrase, ...terms].join(' OR ');
}

export interface SearchOptions extends ListOptions {
  /** Half-life in days for the recency boost applied on top of BM25. */
  recencyHalfLifeDays?: number;
}

export interface SearchHit {
  observation: Observation;
  score: number;
}

/**
 * Keyword search over the FTS index, re-ranked by recency: a strong match from
 * last week should beat an equally strong one from six months ago.
 */
export function searchObservations(db: Db, query: string, options: SearchOptions = {}): SearchHit[] {
  const match = toMatchExpression(query);
  if (!match) return [];

  const limit = Math.min(Math.max(options.limit ?? 10, 1), 200);
  const where: string[] = ['observations_fts MATCH ?'];
  const params: (string | number)[] = [match];

  if (options.project) {
    where.push('o.project = ?');
    params.push(options.project);
  }
  if (options.type) {
    where.push('o.type = ?');
    params.push(options.type);
  }

  // Column weights: a title hit is worth far more than a path hit.
  const sql = `
    SELECT ${OBSERVATION_COLUMNS},
           bm25(observations_fts, 10.0, 3.0, 5.0, 4.0, 1.0, 2.0) AS rank
      FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
      JOIN sessions s ON s.id = o.session_id
     WHERE ${where.join(' AND ')}
     ORDER BY rank
     LIMIT ?`;

  const rows = queryAll<ObservationRow & { rank: number }>(db, sql, ...params, limit * 4);
  const halfLife = options.recencyHalfLifeDays ?? 30;
  const now = Date.now();

  return rows
    .map((row) => {
      const observation = toObservation(row);
      // bm25() is negative, more negative meaning a better match.
      const relevance = -row.rank;
      const ageDays = Math.max(0, (now - Date.parse(observation.createdAt)) / 86_400_000);
      const recency = Math.pow(0.5, ageDays / halfLife);
      return { observation, score: relevance * (1 + 0.5 * recency) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function listProjects(db: Db): { project: string; observations: number; lastSeen: string }[] {
  return queryAll<{ project: string; observations: number; lastSeen: string }>(
    db,
    `SELECT project,
            COUNT(*) AS observations,
            MAX(created_at) AS lastSeen
       FROM observations
      GROUP BY project
      ORDER BY lastSeen DESC`,
  );
}

export function listSessions(
  db: Db,
  options: { project?: string | null; limit?: number } = {},
): SessionRecord[] {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200);
  const rows = options.project
    ? queryAll<SessionRow>(
        db,
        'SELECT * FROM sessions WHERE project = ? ORDER BY started_at DESC LIMIT ?',
        options.project,
        limit,
      )
    : queryAll<SessionRow>(db, 'SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?', limit);
  return rows.map(toSession);
}

export function getSession(db: Db, sessionId: string): SessionRecord | null {
  const row = queryOne<SessionRow>(db, 'SELECT * FROM sessions WHERE id = ?', sessionId);
  return row ? toSession(row) : null;
}

export interface Stats {
  observations: number;
  sessions: number;
  projects: number;
  lastObservationAt: string | null;
}

export function stats(db: Db): Stats {
  return queryOne<Stats>(
    db,
    `SELECT (SELECT COUNT(*) FROM observations) AS observations,
            (SELECT COUNT(*) FROM sessions) AS sessions,
            (SELECT COUNT(DISTINCT project) FROM observations) AS projects,
            (SELECT MAX(created_at) FROM observations) AS lastObservationAt`,
  )!;
}

/** Drops every observation and session for a project. Used by `boltmem forget`. */
export function forgetProject(db: Db, project: string): number {
  return transact(db, () => {
    const { count } = queryOne<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM observations WHERE project = ?',
      project,
    )!;
    db.prepare('DELETE FROM observations WHERE project = ?').run(project);
    db.prepare('DELETE FROM sessions WHERE project = ?').run(project);
    return count;
  });
}
