import { spawn } from 'node:child_process';
import { openDb } from '../db/index.js';
import { ensureSession, finishSession, insertObservations } from '../db/queries.js';
import { loadConfig, projectFromCwd, type Config } from '../config.js';
import { buildPromptContext, buildSessionContext } from '../memory.js';
import { extractFromTranscript, isChildProcess } from '../extract/index.js';
import { log } from '../log.js';
import type { HookPayload } from '../types.js';

export type HookEvent = 'session-start' | 'user-prompt-submit' | 'pre-compact' | 'session-end';

/** Emits the `additionalContext` envelope Claude Code reads from hook stdout. */
function contextOutput(hookEventName: string, additionalContext: string | null): string {
  if (!additionalContext) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } });
}

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export function parsePayload(raw: string): HookPayload {
  try {
    const parsed = JSON.parse(raw) as HookPayload;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Hands extraction to a detached `boltmem extract` so the hook returns straight
 * away. A session end that waits on a model call is a session end the user feels.
 */
function scheduleExtraction(config: Config, payload: HookPayload, project: string): void {
  const entry = process.argv[1];
  if (!entry || !payload.transcript_path || !payload.session_id) return;

  const args = [
    entry,
    'extract',
    '--session',
    payload.session_id,
    '--transcript',
    payload.transcript_path,
    '--project',
    project,
  ];
  if (payload.cwd) args.push('--cwd', payload.cwd);

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, BOLTMEM_HOME: config.home },
  });
  child.unref();
}

async function runExtractionInline(
  config: Config,
  payload: HookPayload,
  project: string,
): Promise<void> {
  if (!payload.transcript_path || !payload.session_id) return;
  const db = openDb(config);
  try {
    ensureSession(db, {
      id: payload.session_id,
      project,
      cwd: payload.cwd ?? null,
      transcriptPath: payload.transcript_path,
    });
    const result = await extractFromTranscript(payload.transcript_path, {
      config,
      project,
      cwd: payload.cwd ?? null,
    });
    const { inserted, skipped } = insertObservations(
      db,
      { sessionId: payload.session_id, project },
      result.observations,
    );
    log(config.home, 'extract', {
      project,
      session: payload.session_id,
      via: result.via,
      inserted: inserted.length,
      skipped,
      warning: result.warning,
    });
  } finally {
    db.close();
  }
}

export interface HookOptions {
  config?: Config;
  /** Run extraction in-process instead of detaching. Used by tests and `--inline`. */
  inline?: boolean;
}

/**
 * Entry point for every hook event. Returns what should be written to stdout.
 * Never throws: a hook that fails loudly is worse than one that forgets.
 */
export async function handleHook(
  event: HookEvent,
  payload: HookPayload,
  options: HookOptions = {},
): Promise<string> {
  const config = options.config ?? loadConfig();

  // Extraction runs Claude headlessly, which fires these same hooks again.
  if (isChildProcess()) return '';

  const project = projectFromCwd(payload.cwd);

  try {
    switch (event) {
      case 'session-start': {
        const db = openDb(config);
        try {
          if (payload.session_id) {
            ensureSession(db, {
              id: payload.session_id,
              project,
              cwd: payload.cwd ?? null,
              transcriptPath: payload.transcript_path ?? null,
            });
          }
          const context = buildSessionContext(db, project, config.startContextLimit);
          log(config.home, 'session-start', {
            project,
            session: payload.session_id,
            source: payload.source,
            injected: context ? context.length : 0,
          });
          return contextOutput('SessionStart', context);
        } finally {
          db.close();
        }
      }

      case 'user-prompt-submit': {
        if (!config.injectOnPrompt || !payload.prompt) return '';
        const db = openDb(config);
        try {
          const context = buildPromptContext(
            db,
            project,
            payload.prompt,
            config.promptContextLimit,
          );
          return contextOutput('UserPromptSubmit', context);
        } finally {
          db.close();
        }
      }

      case 'pre-compact':
      case 'session-end': {
        if (event === 'session-end' && payload.session_id) {
          const db = openDb(config);
          try {
            ensureSession(db, {
              id: payload.session_id,
              project,
              cwd: payload.cwd ?? null,
              transcriptPath: payload.transcript_path ?? null,
            });
            finishSession(db, payload.session_id, payload.reason ?? null);
          } finally {
            db.close();
          }
        }

        log(config.home, event, {
          project,
          session: payload.session_id,
          trigger: payload.trigger ?? payload.reason,
        });

        if (options.inline) {
          await runExtractionInline(config, payload, project);
        } else {
          scheduleExtraction(config, payload, project);
        }
        return '';
      }

      default:
        return '';
    }
  } catch (error) {
    log(config.home, 'hook-error', {
      event,
      project,
      message: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}
