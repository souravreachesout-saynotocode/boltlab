import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { openDb } from '../src/db/index.js';
import {
  ensureSession,
  forgetProject,
  insertObservations,
  listObservations,
  listProjects,
  searchObservations,
  stats,
  toMatchExpression,
} from '../src/db/queries.js';
import type { ObservationInput } from '../src/types.js';
import { tempHome } from './helpers.js';

const { config, cleanup } = tempHome();
const db = openDb(config);

after(() => {
  db.close();
  cleanup();
});

function observation(overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    type: 'discovery',
    title: 'Session store falls back to memory when Redis is unreachable',
    narrative: 'The connection wrapper swallows ECONNREFUSED and installs an in-process map.',
    facts: ['Fallback lives in src/session/store.ts', 'No warning is logged on fallback'],
    scope: 'session-store',
    files: ['src/session/store.ts'],
    keywords: ['redis', 'fallback'],
    ...overrides,
  };
}

describe('store', () => {
  it('numbers sessions per project and observations globally', () => {
    ensureSession(db, { id: 's1', project: 'alpha', cwd: '/tmp/alpha' });
    ensureSession(db, { id: 's2', project: 'alpha', cwd: '/tmp/alpha' });
    ensureSession(db, { id: 's3', project: 'beta', cwd: '/tmp/beta' });

    const first = insertObservations(db, { sessionId: 's1', project: 'alpha' }, [observation()]);
    const second = insertObservations(db, { sessionId: 's3', project: 'beta' }, [
      observation({
        title: 'Beta project uses a different queue adapter',
        narrative: 'Unrelated to anything in alpha.',
        facts: [],
        keywords: [],
        files: [],
      }),
    ]);

    assert.equal(first.inserted[0]?.seq, 1);
    assert.equal(second.inserted[0]?.seq, 2);
    assert.equal(listProjects(db).length, 2);
  });

  it('skips an observation it has already stored for the session', () => {
    const result = insertObservations(db, { sessionId: 's1', project: 'alpha' }, [
      observation(),
      observation({ title: 'A genuinely different finding about the queue adapter' }),
    ]);
    assert.equal(result.skipped, 1);
    assert.equal(result.inserted.length, 1);
  });

  it('filters the recent feed by project and type', () => {
    insertObservations(db, { sessionId: 's2', project: 'alpha' }, [
      observation({ type: 'issue', title: 'Retry loop never terminates when the queue is empty' }),
    ]);

    const issues = listObservations(db, { project: 'alpha', type: 'issue' });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.type, 'issue');
    assert.ok(listObservations(db, { project: 'beta' }).every((item) => item.project === 'beta'));
  });

  it('finds observations by keyword and respects the project scope', () => {
    const hits = searchObservations(db, 'redis fallback', { project: 'alpha' });
    assert.ok(hits.length > 0);
    assert.ok(hits[0]?.observation.title.includes('Redis'));
    assert.equal(searchObservations(db, 'redis fallback', { project: 'beta' }).length, 0);
  });

  it('ranks a title match above a body-only match', () => {
    insertObservations(db, { sessionId: 's2', project: 'alpha' }, [
      observation({
        type: 'change',
        title: 'Queue adapter now retries with exponential backoff',
        narrative: 'Unrelated body text.',
        facts: [],
        keywords: [],
      }),
      observation({
        type: 'change',
        title: 'Unrelated cleanup of the logging helper',
        narrative: 'Mentions the queue adapter only in passing.',
        facts: [],
        keywords: [],
      }),
    ]);

    const hits = searchObservations(db, 'queue adapter backoff', { project: 'alpha' });
    assert.ok(hits[0]?.observation.title.includes('exponential backoff'));
  });

  it('treats punctuation in a query as text, not FTS syntax', () => {
    assert.equal(toMatchExpression('  ??  '), null);
    assert.equal(toMatchExpression('redis'), '"redis"*');
    assert.doesNotThrow(() => searchObservations(db, 'store.ts OR (NEAR "x"'));
  });

  it('forgets a project without touching the others', () => {
    const before = stats(db).observations;
    const removed = forgetProject(db, 'beta');
    assert.equal(removed, 1);
    assert.equal(stats(db).observations, before - 1);
    assert.ok(listProjects(db).every((project) => project.project !== 'beta'));
  });
});
