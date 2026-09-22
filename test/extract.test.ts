import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { extractJsonArray, normalizeObservations } from '../src/extract/parse.js';
import { heuristicExtract } from '../src/extract/heuristic.js';
import { extractFromTranscript } from '../src/extract/index.js';
import { buildDigest, parseTranscript } from '../src/transcript.js';
import { tempHome, transcriptLines } from './helpers.js';

const { config, cleanup } = tempHome();
after(cleanup);

const SAMPLE = transcriptLines([
  { type: 'user', timestamp: '2026-09-20T10:00:00Z', message: { role: 'user', content: 'Fix the flaky auth test' } },
  {
    type: 'assistant',
    timestamp: '2026-09-20T10:00:05Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking at the token clock skew.' },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'src/auth/token.ts', old_string: 'a', new_string: 'b' } },
      ],
    },
  },
  {
    type: 'assistant',
    timestamp: '2026-09-20T10:01:00Z',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- auth' } }],
    },
  },
  { type: 'user', isMeta: true, message: { role: 'user', content: 'ignored meta entry' } },
  { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
]);

describe('transcript parsing', () => {
  it('reads turns, tool calls and touched files, skipping meta and command echoes', () => {
    const path = join(config.home, 'sample.jsonl');
    writeFileSync(path, SAMPLE, 'utf8');
    const transcript = parseTranscript(path);

    assert.equal(transcript.openingPrompt, 'Fix the flaky auth test');
    assert.deepEqual(transcript.files, ['src/auth/token.ts']);
    assert.equal(transcript.toolCalls.length, 2);
    assert.ok(transcript.turns.every((turn) => !turn.text.includes('ignored meta entry')));
    assert.ok(transcript.turns.every((turn) => !turn.text.startsWith('<command-name')));
  });

  it('survives a truncated final line', () => {
    const path = join(config.home, 'partial.jsonl');
    writeFileSync(path, `${SAMPLE}\n{"type":"assistant","mess`, 'utf8');
    assert.equal(parseTranscript(path).toolCalls.length, 2);
  });

  it('keeps the head and tail when the digest exceeds the budget', () => {
    const path = join(config.home, 'sample.jsonl');
    const transcript = parseTranscript(path);
    const digest = buildDigest(transcript, 60);
    assert.ok(digest.length < 260);
    assert.ok(digest.includes('omitted'));
  });
});

describe('extractor output parsing', () => {
  it('accepts a bare array, a fenced array and an observations wrapper', () => {
    assert.equal(extractJsonArray('[{"title":"a"}]')?.length, 1);
    assert.equal(extractJsonArray('here you go:\n```json\n[{"title":"a"}]\n```')?.length, 1);
    assert.equal(extractJsonArray('{"observations":[{"title":"a"},{"title":"b"}]}')?.length, 2);
    assert.equal(extractJsonArray('not json at all'), null);
  });

  it('drops malformed entries and normalises the rest', () => {
    const observations = normalizeObservations(
      [
        { type: 'nonsense', title: 'Token clock skew breaks the auth test on slow CI', facts: ['one', 2] },
        { title: 'short' },
        null,
        { type: 'issue', title: 'Retry loop spins when the queue drains', scope: 'Queue Adapter!!' },
      ],
      10,
    );

    assert.equal(observations.length, 2);
    assert.equal(observations[0]?.type, 'discovery', 'unknown types fall back to discovery');
    assert.deepEqual(observations[0]?.facts, ['one']);
    assert.equal(observations[1]?.scope, 'queue-adapter');
  });

  it('honours the maximum', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ title: `Observation number ${index} about the parser` }));
    assert.equal(normalizeObservations(many, 5).length, 5);
  });
});

describe('offline fallback', () => {
  it('records the goal, the edited files and the commands run', () => {
    const path = join(config.home, 'sample.jsonl');
    const observations = heuristicExtract(parseTranscript(path), 12);
    const titles = observations.map((observation) => observation.title);

    assert.ok(titles.some((title) => title.startsWith('Session worked on')));
    assert.ok(titles.some((title) => title.includes('src/auth/token.ts')));
    assert.ok(titles.some((title) => title.includes('shell command')));
  });

  it('is what extractFromTranscript uses when the extractor is set to heuristic', async () => {
    const path = join(config.home, 'sample.jsonl');
    const result = await extractFromTranscript(path, { config, project: 'alpha', cwd: '/tmp/alpha' });
    assert.equal(result.via, 'heuristic');
    assert.ok(result.observations.length > 0);
  });

  it('reports an empty transcript instead of inventing memories', async () => {
    const path = join(config.home, 'empty.jsonl');
    writeFileSync(path, '', 'utf8');
    const result = await extractFromTranscript(path, { config, project: 'alpha' });
    assert.equal(result.via, 'none');
    assert.deepEqual(result.observations, []);
  });
});
