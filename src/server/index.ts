import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import { openDb, type Db } from '../db/index.js';
import {
  forgetProject,
  getSession,
  listObservations,
  listProjects,
  listSessions,
  searchObservations,
  stats,
} from '../db/queries.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../web');

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function serveStatic(response: ServerResponse, pathname: string): void {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // normalize + prefix check keeps `..` from walking out of the web directory.
  const target = join(webRoot, normalize(relative));
  if (!target.startsWith(webRoot) || !existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(target).pipe(response);
}

function numberParam(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function handleApi(db: Db, url: URL, request: IncomingMessage, response: ServerResponse): boolean {
  const query = url.searchParams;
  const project = query.get('project');
  const scopedProject = project && project !== 'all' ? project : null;

  switch (url.pathname) {
    case '/api/health':
      sendJson(response, 200, { ok: true });
      return true;

    case '/api/stats':
      sendJson(response, 200, stats(db));
      return true;

    case '/api/projects':
      sendJson(response, 200, { projects: listProjects(db) });
      return true;

    case '/api/sessions':
      sendJson(response, 200, {
        sessions: listSessions(db, { project: scopedProject, limit: numberParam(query.get('limit'), 50) }),
      });
      return true;

    case '/api/observations': {
      const search = query.get('q');
      const limit = numberParam(query.get('limit'), 50);
      const type = query.get('type');

      if (search && search.trim()) {
        const hits = searchObservations(db, search, {
          project: scopedProject,
          type,
          limit,
        });
        sendJson(response, 200, {
          mode: 'search',
          observations: hits.map((hit) => ({ ...hit.observation, score: hit.score })),
        });
        return true;
      }

      const observations = listObservations(db, {
        project: scopedProject,
        type,
        sessionId: query.get('session'),
        before: numberParam(query.get('before'), 0) || null,
        limit,
      });
      sendJson(response, 200, { mode: 'recent', observations });
      return true;
    }

    case '/api/session': {
      const id = query.get('id');
      if (!id) {
        sendJson(response, 400, { error: 'id is required' });
        return true;
      }
      const session = getSession(db, id);
      if (!session) {
        sendJson(response, 404, { error: 'no such session' });
        return true;
      }
      sendJson(response, 200, { session, observations: listObservations(db, { sessionId: id, limit: 200 }) });
      return true;
    }

    case '/api/forget': {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'POST required' });
        return true;
      }
      if (!scopedProject) {
        sendJson(response, 400, { error: 'project is required' });
        return true;
      }
      sendJson(response, 200, { removed: forgetProject(db, scopedProject), project: scopedProject });
      return true;
    }

    default:
      return false;
  }
}

export interface ServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * The local viewer. Bound to loopback on purpose — the store holds whatever the
 * sessions discussed, and nothing here authenticates a caller.
 */
export function startServer(config: Config, options: { port?: number; host?: string } = {}): Promise<ServerHandle> {
  const db = openDb(config);
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? config.port;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}:${port}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!handleApi(db, url, request, response)) sendJson(response, 404, { error: 'unknown endpoint' });
        return;
      }
      serveStatic(response, url.pathname);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => {
      server.removeListener('error', rejectPromise);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolvePromise({
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              db.close();
              done();
            });
          }),
      });
    });
  });
}
