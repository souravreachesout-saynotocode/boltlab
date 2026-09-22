import { spawn } from 'node:child_process';

export interface ClaudeRunResult {
  ok: boolean;
  text: string;
  error?: string;
}

/** Marks every process below an extraction run so the hooks can bail out of it. */
export const CHILD_ENV_FLAG = 'BOLTMEM_CHILD';

export function isChildProcess(): boolean {
  return process.env[CHILD_ENV_FLAG] === '1';
}

/**
 * Runs the extraction prompt through the `claude` CLI in headless mode.
 *
 * The child inherits BOLTMEM_CHILD=1, which is what stops the recursion: the
 * headless session fires the same SessionStart/SessionEnd hooks, and they exit
 * immediately when they see the flag.
 */
export function runClaude(
  prompt: string,
  options: { model: string; timeoutSec: number; binary?: string },
): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      options.binary ?? 'claude',
      ['-p', '--output-format', 'json', '--model', options.model],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, [CHILD_ENV_FLAG]: '1' },
      },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, text: '', error: `extraction timed out after ${options.timeoutSec}s` });
    }, options.timeoutSec * 1_000);

    const finish = (result: ClaudeRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => finish({ ok: false, text: '', error: error.message }));

    child.on('close', (code: number | null) => {
      if (code !== 0) {
        finish({ ok: false, text: '', error: stderr.trim() || `claude exited with code ${code}` });
        return;
      }
      try {
        const payload = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
        if (payload.is_error) {
          finish({ ok: false, text: '', error: String(payload.result ?? 'claude reported an error') });
          return;
        }
        finish({ ok: true, text: typeof payload.result === 'string' ? payload.result : stdout });
      } catch {
        // --output-format json is the contract, but raw text is still parseable.
        finish({ ok: true, text: stdout });
      }
    });

    child.stdin.end(prompt, 'utf8');
  });
}
