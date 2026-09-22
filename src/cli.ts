#!/usr/bin/env node
import './quiet.js';
import { loadConfig, projectFromCwd, type Config } from './config.js';
import { openDb } from './db/index.js';
import {
  ensureSession,
  forgetProject,
  insertObservations,
  listObservations,
  listProjects,
  searchObservations,
  stats,
} from './db/queries.js';
import { extractFromTranscript } from './extract/index.js';
import { defaultTranscriptRoot, planBackfill, runBackfill, type BackfillOptions } from './backfill.js';
import { handleHook, parsePayload, readStdin, type HookEvent } from './hooks/index.js';
import { cliEntryPath, install, isInstalled, settingsPath, uninstall, type Scope } from './install.js';
import { startServer } from './server/index.js';
import type { Observation } from './types.js';

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return { command, positional, flags };
}

function flagString(flags: Args['flags'], key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function flagNumber(flags: Args['flags'], key: string, fallback: number): number {
  const parsed = Number.parseInt(flagString(flags, key) ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function scopeFrom(flags: Args['flags']): Scope {
  const scope = flagString(flags, 'scope');
  return scope === 'project' || scope === 'local' ? scope : 'user';
}

function printObservation(observation: Observation & { score?: number }): void {
  const stamp = observation.createdAt.slice(0, 16).replace('T', ' ');
  const score = observation.score === undefined ? '' : ` · score ${observation.score.toFixed(2)}`;
  console.log(`#${observation.seq} [${observation.type}] ${observation.title}`);
  console.log(`   ${observation.project}${observation.scope ? ` · ${observation.scope}` : ''} · ${stamp}${score}`);
  if (observation.narrative) console.log(`   ${observation.narrative}`);
  for (const fact of observation.facts.slice(0, 3)) console.log(`   · ${fact}`);
  if (observation.files.length > 0) console.log(`   files: ${observation.files.slice(0, 4).join(', ')}`);
  console.log('');
}

const HELP = `boltmem — persistent memory for Claude Code sessions

Usage
  boltmem install [--scope user|project|local]   Add the hooks to Claude Code settings
  boltmem uninstall [--scope ...]                Remove them again
  boltmem serve [--port 37777]                   Start the local viewer
  boltmem list [--project p] [--limit n]         Most recent memories
  boltmem search <query> [--project p]           Keyword search over the store
  boltmem extract --transcript <path>            Run the extraction pass by hand
                  [--session id] [--project p] [--cwd dir] [--dry-run]
  boltmem backfill [--days 30] [--limit n]       Extract memory from past sessions
                   [--project p] [--root dir] [--concurrency 2]
                   [--min-turns 4] [--force] [--dry-run] [--yes]
  boltmem status                                 Store location, counts, install state
  boltmem forget <project> --yes                 Delete everything for one project
  boltmem hook <event>                           Internal: run a hook (reads stdin)

Environment
  BOLTMEM_HOME   store directory (default ~/.boltmem)
  BOLTMEM_PORT   viewer port (default 37777)
  BOLTMEM_MODEL  model used for extraction
`;

async function commandExtract(config: Config, args: Args): Promise<number> {
  const transcript = flagString(args.flags, 'transcript') ?? args.positional[0];
  if (!transcript) {
    console.error('boltmem extract: --transcript <path> is required');
    return 1;
  }

  const cwd = flagString(args.flags, 'cwd') ?? process.cwd();
  const project = flagString(args.flags, 'project') ?? projectFromCwd(cwd);
  const sessionId = flagString(args.flags, 'session') ?? `manual-${Date.now()}`;
  const dryRun = args.flags['dry-run'] === true;

  const result = await extractFromTranscript(transcript, { config, project, cwd });
  if (result.warning) console.error(`warning: ${result.warning}`);

  if (dryRun) {
    console.log(JSON.stringify(result.observations, null, 2));
    console.log(`\n${result.observations.length} observation(s) via ${result.via}; nothing written.`);
    return 0;
  }

  const db = openDb(config);
  try {
    ensureSession(db, { id: sessionId, project, cwd, transcriptPath: transcript });
    const { inserted, skipped } = insertObservations(db, { sessionId, project }, result.observations);
    console.log(
      `stored ${inserted.length} observation(s) via ${result.via}` +
        (skipped > 0 ? `, skipped ${skipped} already known` : ''),
    );
    for (const observation of inserted) printObservation(observation);
  } finally {
    db.close();
  }
  return 0;
}

/** Sessions a backfill will run before it asks for confirmation. */
const BACKFILL_AUTO_LIMIT = 25;

function backfillOptionsFrom(args: Args): BackfillOptions {
  return {
    root: flagString(args.flags, 'root') ?? defaultTranscriptRoot(),
    project: flagString(args.flags, 'project') ?? null,
    days: flagString(args.flags, 'days') ? flagNumber(args.flags, 'days', 0) : null,
    limit: flagString(args.flags, 'limit') ? flagNumber(args.flags, 'limit', 0) : null,
    minTurns: flagNumber(args.flags, 'min-turns', 4),
    force: args.flags.force === true,
    concurrency: flagNumber(args.flags, 'concurrency', 2),
  };
}

function summariseSkips(skipped: { skip?: string }[]): string {
  const counts = new Map<string, number>();
  for (const entry of skipped) {
    const reason = entry.skip ?? 'other';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts]
    .map(([reason, count]) => `${count} ${reason.replace(/-/g, ' ')}`)
    .join(', ');
}

async function commandBackfill(config: Config, args: Args): Promise<number> {
  const options = backfillOptionsFrom(args);
  const plan = planBackfill(config, options);

  console.log(`scanned ${plan.scanned} transcript(s) under ${plan.root}`);
  if (plan.skipped.length > 0) console.log(`skipping ${summariseSkips(plan.skipped)}`);

  if (plan.planned.length === 0) {
    console.log('nothing to backfill.');
    return 0;
  }

  const byProject = new Map<string, number>();
  for (const session of plan.planned) {
    byProject.set(session.project, (byProject.get(session.project) ?? 0) + 1);
  }
  console.log(`\n${plan.planned.length} session(s) to extract:`);
  for (const [project, count] of [...byProject].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${project.padEnd(28)} ${count}`);
  }

  if (args.flags['dry-run'] === true) {
    console.log('\ndry run: nothing was extracted.');
    return 0;
  }

  // Each session costs a model call, so a large run is confirmed rather than assumed.
  if (plan.planned.length > BACKFILL_AUTO_LIMIT && args.flags.yes !== true) {
    console.log(
      `\nthat is ${plan.planned.length} model calls. Re-run with --yes to go ahead, ` +
        `or narrow it with --limit / --days / --project.`,
    );
    return 0;
  }

  console.log('');
  const result = await runBackfill(config, options, (progress) => {
    const position = `[${String(progress.index + 1).padStart(String(progress.total).length)}/${progress.total}]`;
    const detail = progress.error
      ? `failed: ${progress.error}`
      : `${progress.inserted} observation(s) via ${progress.via}`;
    console.log(`${position} ${progress.session.project}/${progress.session.sessionId.slice(0, 8)} — ${detail}`);
  });

  console.log(
    `\nbackfilled ${result.inserted} observation(s) from ${result.processed} session(s)` +
      (result.failed > 0 ? `, ${result.failed} failed (see ${config.home}/boltmem.log)` : ''),
  );
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(
    flagString(args.flags, 'home') ? { home: flagString(args.flags, 'home') } : {},
  );

  switch (args.command) {
    case 'hook': {
      const event = args.positional[0] as HookEvent | undefined;
      if (!event) return 1;
      const payload = parsePayload(await readStdin());
      const output = await handleHook(event, payload, {
        config,
        inline: args.flags.inline === true,
      });
      if (output) process.stdout.write(output);
      return 0;
    }

    case 'install': {
      const scope = scopeFrom(args.flags);
      const result = install(scope, process.cwd(), flagString(args.flags, 'entry') ?? cliEntryPath());
      console.log(`hooks installed in ${result.path}`);
      console.log(`events: ${result.events.join(', ')}`);
      if (result.backedUp) console.log(`previous settings copied to ${result.path}.boltmem-backup`);
      console.log(`store: ${config.dbPath}`);
      console.log('open a new Claude Code session to pick them up.');
      return 0;
    }

    case 'uninstall': {
      const result = uninstall(scopeFrom(args.flags));
      console.log(`removed ${result.removed} boltmem hook(s) from ${result.path}`);
      return 0;
    }

    case 'serve': {
      const port = flagNumber(args.flags, 'port', config.port);
      const handle = await startServer(config, { port });
      console.log(`boltmem viewer on ${handle.url}`);
      console.log(`store: ${config.dbPath}`);
      const shutdown = () => {
        void handle.close().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return -1; // keep the process alive
    }

    case 'list': {
      const db = openDb(config);
      try {
        const observations = listObservations(db, {
          project: flagString(args.flags, 'project') ?? null,
          type: flagString(args.flags, 'type') ?? null,
          limit: flagNumber(args.flags, 'limit', 20),
        });
        if (args.flags.json === true) console.log(JSON.stringify(observations, null, 2));
        else if (observations.length === 0) console.log('memory is empty.');
        else observations.forEach(printObservation);
      } finally {
        db.close();
      }
      return 0;
    }

    case 'search': {
      const query = args.positional.join(' ');
      if (!query) {
        console.error('boltmem search: a query is required');
        return 1;
      }
      const db = openDb(config);
      try {
        const hits = searchObservations(db, query, {
          project: flagString(args.flags, 'project') ?? null,
          limit: flagNumber(args.flags, 'limit', 10),
        });
        if (args.flags.json === true) {
          console.log(JSON.stringify(hits, null, 2));
        } else if (hits.length === 0) {
          console.log('no matches.');
        } else {
          hits.forEach((hit) => printObservation({ ...hit.observation, score: hit.score }));
        }
      } finally {
        db.close();
      }
      return 0;
    }

    case 'status': {
      const db = openDb(config);
      try {
        const counts = stats(db);
        console.log(`store        ${config.dbPath}`);
        console.log(`observations ${counts.observations}`);
        console.log(`sessions     ${counts.sessions}`);
        console.log(`projects     ${counts.projects}`);
        console.log(`last written ${counts.lastObservationAt ?? 'never'}`);
        console.log(`extractor    ${config.extractor} (model ${config.model})`);
        console.log(`viewer port  ${config.port}`);
        for (const scope of ['user', 'project', 'local'] as Scope[]) {
          console.log(
            `hooks ${scope.padEnd(8)} ${isInstalled(scope) ? 'installed' : 'not installed'}  ${settingsPath(scope)}`,
          );
        }
        const projects = listProjects(db);
        if (projects.length > 0) {
          console.log('\nprojects');
          for (const project of projects) {
            console.log(`  ${project.project.padEnd(24)} ${String(project.observations).padStart(5)}  last ${project.lastSeen.slice(0, 10)}`);
          }
        }
      } finally {
        db.close();
      }
      return 0;
    }

    case 'forget': {
      const project = args.positional[0];
      if (!project) {
        console.error('boltmem forget: a project name is required');
        return 1;
      }
      const db = openDb(config);
      try {
        if (args.flags.yes !== true) {
          const counts = listProjects(db).find((entry) => entry.project === project);
          console.log(
            `would delete ${counts?.observations ?? 0} observation(s) for "${project}". Re-run with --yes to confirm.`,
          );
          return 0;
        }
        console.log(`deleted ${forgetProject(db, project)} observation(s) for "${project}".`);
      } finally {
        db.close();
      }
      return 0;
    }

    case 'extract':
      return commandExtract(config, args);

    case 'backfill':
      return commandBackfill(config, args);

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;

    default:
      console.error(`unknown command: ${args.command}\n`);
      console.log(HELP);
      return 1;
  }
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
