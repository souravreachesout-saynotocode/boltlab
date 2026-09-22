import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/db/index.js';
import { listObservations, observationCount } from '../src/db/queries.js';
import { discoverTranscripts, planBackfill, runBackfill } from '../src/backfill.js';
import { tempHome, transcriptLines } from './helpers.js';

const { config, cleanup } = tempHome();
const root = join(config.home, 'projects');

function writeTranscript(
  dir: string,
  sessionId: string,
  options: { cwd: string; turns: number; ageDays?: number },
): string {
  mkdirSync(join(root, dir), { recursive: true });
  const entries: unknown[] = [];
  const started = Date.parse('2026-09-01T09:00:00Z');

  for (let index = 0; index < options.turns; index += 1) {
    const timestamp = new Date(started + index * 60_000).toISOString();
    entries.push({
      type: index % 2 === 0 ? 'user' : 'assistant',
      sessionId,
      cwd: options.cwd,
      timestamp,
      message: {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content:
          index % 2 === 0
            ? `Turn ${index}: please look at the retry helper`
            : [
                { type: 'text', text: `Reply ${index}` },
                { type: 'tool_use', name: 'Edit', input: { file_path: 'src/retry.ts' } },
              ],
      },
    });
  }

  const path = join(root, dir, `${sessionId}.jsonl`);
  writeFileSync(path, transcriptLines(entries), 'utf8');
  if (options.ageDays) {
    const when = new Date(Date.now() - options.ageDays * 86_400_000);
    utimesSync(path, when, when);
  }
  return path;
}

before(() => {
  writeTranscript('-home-user-alpha', 'alpha-session-1', { cwd: '/home/user/alpha', turns: 8 });
  writeTranscript('-home-user-alpha', 'alpha-session-2', { cwd: '/home/user/alpha', turns: 6 });
  writeTranscript('-home-user-beta', 'beta-session-1', { cwd: '/home/user/beta', turns: 6 });
  writeTranscript('-home-user-alpha', 'alpha-stub', { cwd: '/home/user/alpha', turns: 2 });
  writeTranscript('-home-user-alpha', 'alpha-ancient', {
    cwd: '/home/user/alpha',
    turns: 6,
    ageDays: 400,
  });
});

after(cleanup);

describe('backfill discovery', () => {
  it('finds every transcript, newest first', () => {
    const files = discoverTranscripts(root);
    assert.equal(files.length, 5);
    assert.ok(files[0]!.modifiedAt.getTime() >= files[files.length - 1]!.modifiedAt.getTime());
    assert.equal(discoverTranscripts(join(config.home, 'nope')).length, 0);
  });

  it('reads the project from the transcript rather than the directory name', () => {
    const plan = planBackfill(config, { root });
    assert.ok(plan.planned.some((session) => session.project === 'alpha'));
    assert.ok(plan.planned.some((session) => session.project === 'beta'));
  });

  it('skips short sessions and honours project, age and limit filters', () => {
    const plan = planBackfill(config, { root });
    assert.ok(plan.skipped.some((session) => session.skip === 'too-short'));
    assert.ok(plan.planned.every((session) => session.sessionId !== 'alpha-stub'));

    const scoped = planBackfill(config, { root, project: 'beta' });
    assert.equal(scoped.planned.length, 1);
    assert.ok(scoped.skipped.some((session) => session.skip === 'other-project'));

    assert.equal(planBackfill(config, { root, days: 30 }).planned.length, 3);
    assert.equal(planBackfill(config, { root, limit: 2 }).planned.length, 2);
  });
});

describe('backfill run', () => {
  it('extracts, dates observations from the transcript, and reports progress', async () => {
    const progress: string[] = [];
    const result = await runBackfill(config, { root, days: 30 }, (event) =>
      progress.push(`${event.session.project}:${event.inserted}`),
    );

    assert.equal(result.processed, 3);
    assert.ok(result.inserted > 0);
    assert.equal(result.failed, 0);
    assert.equal(progress.length, 3);

    const stored = listObservations(openDb(config), { project: 'alpha', limit: 50 });
    assert.ok(stored.length > 0);
    assert.ok(
      stored.every((observation) => observation.createdAt.startsWith('2026-09-01')),
      'backfilled memories keep the session date, not today',
    );
  });

  it('does not re-extract a session it has already covered', async () => {
    const before = observationCount(openDb(config), 'alpha-session-1');
    const second = await runBackfill(config, { root, days: 30 });

    assert.equal(second.processed, 0);
    assert.ok(second.plan.skipped.some((session) => session.skip === 'already-extracted'));
    assert.equal(observationCount(openDb(config), 'alpha-session-1'), before);
  });

  it('re-extracts when forced, without duplicating what it already stored', async () => {
    const before = observationCount(openDb(config), 'alpha-session-1');
    const forced = await runBackfill(config, { root, days: 30, force: true });

    assert.equal(forced.processed, 3);
    assert.equal(forced.inserted, 0, 'content hashing absorbs the repeat');
    assert.equal(observationCount(openDb(config), 'alpha-session-1'), before);
  });
});
