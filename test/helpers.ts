import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';

export function tempHome(): { config: Config; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'boltmem-test-'));
  const config = loadConfig({ home, extractor: 'heuristic' });
  return { config, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function transcriptLines(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}
