/**
 * node:sqlite is still flagged experimental in Node 22, which prints a warning to
 * stderr on first use. Hooks run inside Claude Code, where stray stderr shows up as
 * hook noise, so the SQLite-specific warning is swallowed here. Everything else
 * (deprecations, other experimental features) still gets through.
 */
const originalEmit = process.emit.bind(process);

process.emit = function patchedEmit(name: string, ...args: unknown[]): boolean {
  const data = args[0] as { name?: string; message?: string } | undefined;
  if (
    name === 'warning' &&
    data?.name === 'ExperimentalWarning' &&
    /SQLite/i.test(data.message ?? '')
  ) {
    return false;
  }
  return originalEmit(name as never, ...(args as never[]));
} as typeof process.emit;
