import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Scope = 'user' | 'project' | 'local';

export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

interface Settings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

/**
 * Every command boltmem writes ends with this flag. The CLI ignores it; it exists
 * so `uninstall` can recognise its own entries no matter where the CLI is
 * installed, and so a reader of settings.json can see who added them.
 */
const MARKER = '--marker boltmem-hook';

export function settingsPath(scope: Scope, cwd = process.cwd()): string {
  switch (scope) {
    case 'user':
      return join(homedir(), '.claude', 'settings.json');
    case 'project':
      return join(resolve(cwd), '.claude', 'settings.json');
    case 'local':
      return join(resolve(cwd), '.claude', 'settings.local.json');
  }
}

/** Absolute path to this CLI's entry point, used inside the hook commands. */
export function cliEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'cli.js');
}

export function buildHookConfig(entry: string): Record<string, HookMatcher[]> {
  const command = (event: string) =>
    `"${process.execPath}" "${entry}" hook ${event} ${MARKER}`;
  return {
    SessionStart: [
      {
        matcher: 'startup|resume|clear',
        hooks: [{ type: 'command', command: command('session-start'), timeout: 20 }],
      },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: command('user-prompt-submit'), timeout: 10 }] },
    ],
    PreCompact: [
      {
        matcher: 'manual|auto',
        hooks: [{ type: 'command', command: command('pre-compact'), timeout: 20 }],
      },
    ],
    SessionEnd: [{ hooks: [{ type: 'command', command: command('session-end'), timeout: 20 }] }],
  };
}

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Settings;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON, so it was left untouched: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.boltmem-backup`);
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function withoutBoltmem(entries: HookMatcher[]): HookMatcher[] {
  return entries
    .map((entry) => ({
      ...entry,
      hooks: (entry.hooks ?? []).filter((hook) => !hook.command?.includes(MARKER)),
    }))
    .filter((entry) => entry.hooks.length > 0);
}

export interface InstallResult {
  path: string;
  events: string[];
  backedUp: boolean;
}

/** Adds (or refreshes) the boltmem hooks, leaving every other hook in place. */
export function install(scope: Scope, cwd = process.cwd(), entry = cliEntryPath()): InstallResult {
  const path = settingsPath(scope, cwd);
  const backedUp = existsSync(path);
  const settings = readSettings(path);
  const hooks = settings.hooks ?? {};
  const desired = buildHookConfig(entry);

  for (const [event, matchers] of Object.entries(desired)) {
    const existing = withoutBoltmem(hooks[event] ?? []);
    hooks[event] = [...existing, ...matchers];
  }

  settings.hooks = hooks;
  writeSettings(path, settings);
  return { path, events: Object.keys(desired), backedUp };
}

export interface UninstallResult {
  path: string;
  removed: number;
}

export function uninstall(scope: Scope, cwd = process.cwd()): UninstallResult {
  const path = settingsPath(scope, cwd);
  if (!existsSync(path)) return { path, removed: 0 };

  const settings = readSettings(path);
  const hooks = settings.hooks ?? {};
  let removed = 0;

  for (const [event, matchers] of Object.entries(hooks)) {
    const before = matchers.reduce((count, entry) => count + (entry.hooks?.length ?? 0), 0);
    const filtered = withoutBoltmem(matchers);
    removed += before - filtered.reduce((count, entry) => count + entry.hooks.length, 0);
    if (filtered.length > 0) hooks[event] = filtered;
    else delete hooks[event];
  }

  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;

  writeSettings(path, settings);
  return { path, removed };
}

/** Whether the boltmem hooks are present in a given settings file. */
export function isInstalled(scope: Scope, cwd = process.cwd()): boolean {
  const path = settingsPath(scope, cwd);
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').includes(MARKER);
  } catch {
    return false;
  }
}
