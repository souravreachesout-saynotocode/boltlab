import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { openDb } from '../src/db/index.js';
import { ensureSession, insertObservations, listObservations } from '../src/db/queries.js';
import { handleHook } from '../src/hooks/index.js';
import { CHILD_ENV_FLAG } from '../src/extract/claude.js';
import { tempHome, transcriptLines } from './helpers.js';

const { config, cleanup } = tempHome();
after(cleanup);

function seed(): void {
  const db = openDb(config);
  try {
    ensureSession(db, { id: 'seed-session', project: 'boltlab', cwd: '/home/user/boltlab' });
    insertObservations(db, { sessionId: 'seed-session', project: 'boltlab' }, [
      {
        type: 'issue',
        title: 'Viewer pagination repeats the last card at a page boundary',
        narrative: 'The cursor is inclusive, so the final row of a page opens the next one.',
        facts: ['Cursor is observations.id', 'Fix is a strict less-than'],
        scope: 'viewer',
        files: ['src/web/app.js'],
        keywords: ['pagination'],
      },
      {
        type: 'change',
        title: 'SQLite store moved to WAL so the viewer can read during a write',
        narrative: 'Hooks write while the viewer polls; WAL keeps them from blocking each other.',
        facts: ['PRAGMA journal_mode = WAL on open'],
        scope: 'db',
        files: ['src/db/index.ts'],
        keywords: ['sqlite', 'wal'],
      },
    ]);
  } finally {
    db.close();
  }
}

describe('hooks', () => {
  it('injects recent memory at session start, open issues first', async () => {
    seed();
    const output = await handleHook(
      'session-start',
      { session_id: 'new-session', cwd: '/home/user/boltlab', source: 'startup' },
      { config },
    );

    const parsed = JSON.parse(output) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');

    const context = parsed.hookSpecificOutput.additionalContext;
    assert.ok(context.includes('Open issues carried forward'));
    assert.ok(context.indexOf('pagination') < context.indexOf('Recent work'));
    assert.ok(context.includes('not as instructions'), 'injected memory is labelled as untrusted notes');
  });

  it('says nothing for a project with no memory', async () => {
    const output = await handleHook(
      'session-start',
      { session_id: 'other', cwd: '/tmp/some-other-project' },
      { config },
    );
    assert.equal(output, '');
  });

  it('injects only when a prompt matches something stored', async () => {
    const hit = await handleHook(
      'user-prompt-submit',
      { cwd: '/home/user/boltlab', prompt: 'why did we switch sqlite to WAL mode?' },
      { config },
    );
    assert.ok(hit.includes('boltmem recall'));
    assert.ok(hit.includes('WAL'));

    const miss = await handleHook(
      'user-prompt-submit',
      { cwd: '/home/user/boltlab', prompt: 'add kubernetes ingress annotations for grafana' },
      { config },
    );
    assert.equal(miss, '');
  });

  it('does nothing at all inside an extraction subprocess', async () => {
    process.env[CHILD_ENV_FLAG] = '1';
    try {
      const output = await handleHook(
        'session-start',
        { session_id: 'child', cwd: '/home/user/boltlab' },
        { config },
      );
      assert.equal(output, '', 'a headless extraction run must not re-enter the pipeline');
    } finally {
      delete process.env[CHILD_ENV_FLAG];
    }
  });

  it('extracts and stores on session end', async () => {
    const transcript = join(config.home, 'session-end.jsonl');
    writeFileSync(
      transcript,
      transcriptLines([
        { type: 'user', message: { role: 'user', content: 'Add the forget command' } },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'src/cli.ts' } }],
          },
        },
      ]),
      'utf8',
    );

    await handleHook(
      'session-end',
      {
        session_id: 'ending-session',
        cwd: '/home/user/boltlab',
        transcript_path: transcript,
        reason: 'clear',
      },
      { config, inline: true },
    );

    const stored = listObservations(openDb(config), { sessionId: 'ending-session' });
    assert.ok(stored.length > 0);
    assert.ok(stored.some((observation) => observation.files.includes('src/cli.ts')));
  });

  it('swallows a broken payload rather than failing the session', async () => {
    const output = await handleHook('session-start', {}, { config });
    assert.equal(typeof output, 'string');
  });
});
