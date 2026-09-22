import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Config } from './config.js';
import { projectFromCwd } from './config.js';
import { openDb } from './db/index.js';
import { ensureSession, finishSession, insertObservations, observationCount } from './db/queries.js';
import { extractFromTranscript } from './extract/index.js';
import { parseTranscript, type Transcript } from './transcript.js';
import { log } from './log.js';

export interface TranscriptFile {
  path: string;
  /** Claude Code names each transcript after its session id. */
  sessionId: string;
  modifiedAt: Date;
  bytes: number;
}

/** Default location of Claude Code's own transcripts. */
export function defaultTranscriptRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Every transcript under `root`, newest first. */
export function discoverTranscripts(root: string): TranscriptFile[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true, encoding: 'utf8' }) as string[];
  } catch {
    return [];
  }

  const files: TranscriptFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const path = join(root, entry);
    try {
      const info = statSync(path);
      if (!info.isFile() || info.size === 0) continue;
      files.push({
        path,
        sessionId: basename(entry, '.jsonl'),
        modifiedAt: info.mtime,
        bytes: info.size,
      });
    } catch {
      continue; // Deleted between the listing and the stat.
    }
  }

  return files.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

export type SkipReason = 'already-extracted' | 'too-short' | 'other-project' | 'too-old';

export interface PlannedSession {
  file: TranscriptFile;
  sessionId: string;
  project: string;
  cwd: string | null;
  transcript: Transcript;
  skip?: SkipReason;
}

export interface BackfillOptions {
  root?: string;
  /** Only sessions from this project. */
  project?: string | null;
  /** Ignore transcripts older than this many days. */
  days?: number | null;
  /** Process at most this many sessions. */
  limit?: number | null;
  /** Sessions with fewer turns than this are not worth a model call. */
  minTurns?: number;
  /** Re-extract sessions that already have observations. */
  force?: boolean;
  /** Model calls in flight at once. */
  concurrency?: number;
}

export interface BackfillPlan {
  root: string;
  scanned: number;
  planned: PlannedSession[];
  skipped: PlannedSession[];
}

/**
 * Decides what a backfill would do, without calling the model. Reading every
 * transcript is cheap next to extracting one, and it is the only way to know a
 * session's project and length.
 */
export function planBackfill(config: Config, options: BackfillOptions = {}): BackfillPlan {
  const root = resolve(options.root ?? defaultTranscriptRoot());
  const files = discoverTranscripts(root);
  const minTurns = options.minTurns ?? 4;
  const cutoff =
    options.days && options.days > 0 ? Date.now() - options.days * 86_400_000 : null;

  const db = openDb(config);
  const planned: PlannedSession[] = [];
  const skipped: PlannedSession[] = [];

  try {
    for (const file of files) {
      if (cutoff !== null && file.modifiedAt.getTime() < cutoff) continue;

      const transcript = parseTranscript(file.path);
      const sessionId = transcript.sessionId ?? file.sessionId;
      const cwd = transcript.cwd;
      const project = projectFromCwd(cwd);
      const entry: PlannedSession = { file, sessionId, project, cwd, transcript };

      if (options.project && project !== options.project) {
        skipped.push({ ...entry, skip: 'other-project' });
        continue;
      }
      if (transcript.turns.length < minTurns) {
        skipped.push({ ...entry, skip: 'too-short' });
        continue;
      }
      if (!options.force && observationCount(db, sessionId) > 0) {
        skipped.push({ ...entry, skip: 'already-extracted' });
        continue;
      }

      planned.push(entry);
      if (options.limit && planned.length >= options.limit) break;
    }
  } finally {
    db.close();
  }

  return { root, scanned: files.length, planned, skipped };
}

export interface BackfillProgress {
  index: number;
  total: number;
  session: PlannedSession;
  inserted: number;
  via: string;
  error?: string;
}

export interface BackfillResult {
  plan: BackfillPlan;
  processed: number;
  inserted: number;
  failed: number;
}

/**
 * Runs the extraction pass over historic transcripts.
 *
 * Observations are dated from the transcript, not from now: a finding from three
 * weeks ago has to rank as three weeks old, or recency weighting would put the
 * whole backfill on top of everything learned since.
 */
export async function runBackfill(
  config: Config,
  options: BackfillOptions = {},
  onProgress: (progress: BackfillProgress) => void = () => {},
): Promise<BackfillResult> {
  const plan = planBackfill(config, options);
  const total = plan.planned.length;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 8));

  let cursor = 0;
  let processed = 0;
  let inserted = 0;
  let failed = 0;

  const worker = async (): Promise<void> => {
    while (cursor < total) {
      const index = cursor++;
      const session = plan.planned[index];
      if (!session) break;

      const createdAt =
        session.transcript.lastTimestamp ??
        session.transcript.firstTimestamp ??
        session.file.modifiedAt.toISOString();

      try {
        const result = await extractFromTranscript(session.file.path, {
          config,
          project: session.project,
          cwd: session.cwd,
        });

        // One connection per session rather than one shared across workers:
        // node:sqlite is synchronous, and WAL handles the concurrent writes.
        const db = openDb(config);
        try {
          ensureSession(db, {
            id: session.sessionId,
            project: session.project,
            cwd: session.cwd,
            transcriptPath: session.file.path,
            startedAt: session.transcript.firstTimestamp ?? createdAt,
          });
          const write = insertObservations(
            db,
            { sessionId: session.sessionId, project: session.project, createdAt },
            result.observations,
          );
          finishSession(db, session.sessionId, 'backfill', createdAt);
          inserted += write.inserted.length;
          processed += 1;
          onProgress({
            index,
            total,
            session,
            inserted: write.inserted.length,
            via: result.via,
            ...(result.warning ? { error: result.warning } : {}),
          });
        } finally {
          db.close();
        }
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        log(config.home, 'backfill-error', { session: session.sessionId, message });
        onProgress({ index, total, session, inserted: 0, via: 'none', error: message });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  log(config.home, 'backfill', { total, processed, inserted, failed });

  return { plan, processed, inserted, failed };
}
