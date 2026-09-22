import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  /** Where the database, logs and config live. */
  home: string;
  dbPath: string;
  /** Port for the local viewer. 37777 by default. */
  port: number;
  /** Model used for the extraction pass. */
  model: string;
  /** 'auto' uses the claude CLI when present and falls back to the offline extractor. */
  extractor: 'auto' | 'claude' | 'heuristic';
  /** Upper bound on observations kept from a single session. */
  maxObservationsPerSession: number;
  /** Characters of transcript digest handed to the extractor. */
  digestCharBudget: number;
  /** Observations injected at SessionStart. */
  startContextLimit: number;
  /** Inject prompt-relevant memories on UserPromptSubmit. */
  injectOnPrompt: boolean;
  /** Observations injected per user prompt. */
  promptContextLimit: number;
  /** Seconds before the extraction subprocess is killed. */
  extractTimeoutSec: number;
}

const DEFAULTS: Omit<Config, 'home' | 'dbPath'> = {
  port: 37777,
  model: 'claude-haiku-4-5-20251001',
  extractor: 'auto',
  maxObservationsPerSession: 12,
  digestCharBudget: 60_000,
  startContextLimit: 12,
  injectOnPrompt: true,
  promptContextLimit: 4,
  extractTimeoutSec: 180,
};

function readFileConfig(home: string): Partial<Config> {
  const file = join(home, 'config.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A broken config file must never take the hooks down with it.
    return {};
  }
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const home = resolve(
    overrides.home ?? process.env.BOLTMEM_HOME ?? join(homedir(), '.boltmem'),
  );
  const fileConfig = readFileConfig(home);
  const merged: Config = {
    ...DEFAULTS,
    ...fileConfig,
    home,
    dbPath: join(home, 'boltmem.db'),
    port: intFromEnv(process.env.BOLTMEM_PORT, fileConfig.port ?? DEFAULTS.port),
    model: process.env.BOLTMEM_MODEL ?? fileConfig.model ?? DEFAULTS.model,
    ...overrides,
  };
  if (overrides.dbPath) merged.dbPath = resolve(overrides.dbPath);
  return merged;
}

/**
 * Project name for a working directory. The basename is enough in practice and
 * keeps the viewer's project filter readable.
 */
export function projectFromCwd(cwd: string | undefined | null): string {
  if (!cwd) return 'unknown';
  const parts = resolve(cwd).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'unknown';
}
