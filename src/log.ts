import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_LOG_BYTES = 5_000_000;

/**
 * Hooks run detached from any terminal, so failures have to land somewhere the
 * user can read them. One file, rotated once when it gets large.
 */
export function log(home: string, event: string, detail: Record<string, unknown> = {}): void {
  const file = join(home, 'boltmem.log');
  try {
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // No log file yet, or rotation raced another process; either is fine.
    }
    const line = `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`;
    appendFileSync(file, line, 'utf8');
  } catch {
    // Logging must never break a hook.
  }
}
