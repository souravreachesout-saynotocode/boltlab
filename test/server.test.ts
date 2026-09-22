import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { openDb } from '../src/db/index.js';
import { ensureSession, insertObservations } from '../src/db/queries.js';
import { startServer, type ServerHandle } from '../src/server/index.js';
import { tempHome } from './helpers.js';

const { config, cleanup } = tempHome();
let server: ServerHandle;

before(async () => {
  const db = openDb(config);
  try {
    ensureSession(db, { id: 'api-session', project: 'boltlab', cwd: '/home/user/boltlab' });
    insertObservations(db, { sessionId: 'api-session', project: 'boltlab' }, [
      {
        type: 'decision',
        title: 'Viewer binds to loopback only',
        narrative: 'The store holds whatever sessions discussed and the API does not authenticate.',
        facts: ['Host is 127.0.0.1'],
        scope: 'server',
        files: ['src/server/index.ts'],
        keywords: ['security', 'loopback'],
      },
    ]);
  } finally {
    db.close();
  }
  server = await startServer(config, { port: 0 });
});

after(async () => {
  await server.close();
  cleanup();
});

describe('viewer API', () => {
  it('serves the recent feed', async () => {
    const response = await fetch(`${server.url}/api/observations`);
    const body = (await response.json()) as { mode: string; observations: { title: string }[] };
    assert.equal(body.mode, 'recent');
    assert.equal(body.observations[0]?.title, 'Viewer binds to loopback only');
  });

  it('switches to search mode when given a query', async () => {
    const response = await fetch(`${server.url}/api/observations?q=loopback`);
    const body = (await response.json()) as { mode: string; observations: { score: number }[] };
    assert.equal(body.mode, 'search');
    assert.ok((body.observations[0]?.score ?? 0) > 0);
  });

  it('scopes by project', async () => {
    const response = await fetch(`${server.url}/api/observations?project=nothing-here`);
    const body = (await response.json()) as { observations: unknown[] };
    assert.deepEqual(body.observations, []);
  });

  it('reports projects and stats', async () => {
    const projects = (await (await fetch(`${server.url}/api/projects`)).json()) as {
      projects: { project: string }[];
    };
    assert.equal(projects.projects[0]?.project, 'boltlab');

    const stats = (await (await fetch(`${server.url}/api/stats`)).json()) as { observations: number };
    assert.equal(stats.observations, 1);
  });

  it('serves the viewer and refuses paths outside it', async () => {
    const page = await fetch(`${server.url}/`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('boltmem'));

    const escape = await fetch(`${server.url}/../../etc/passwd`, { redirect: 'manual' });
    assert.ok(escape.status === 404 || escape.status === 400, `expected a refusal, got ${escape.status}`);
  });

  it('rejects an unknown endpoint and a forget without a project', async () => {
    assert.equal((await fetch(`${server.url}/api/nope`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/forget`, { method: 'POST' })).status, 400);
  });
});
