# boltmem

Persistent, searchable memory for Claude Code sessions.

Claude Code forgets everything between sessions. boltmem sits in the hook layer: it
watches sessions end, compresses each transcript into a handful of durable
*observations*, stores them in SQLite, and injects the relevant ones back at the
start of the next session in that project. A local viewer on
`http://127.0.0.1:37777` shows the whole timeline.

```
┌──────────────┐  transcript  ┌───────────┐  observations  ┌──────────┐
│ Claude Code  │─────────────▶│ extractor │───────────────▶│  SQLite  │
│   session    │              │ (claude -p)│                │  + FTS5  │
└──────────────┘              └───────────┘                └────┬─────┘
       ▲                                                        │
       │           SessionStart / UserPromptSubmit              │
       └────────────────── injected context ────────────────────┘
                                                                │
                                                     ┌──────────▼─────────┐
                                                     │ viewer :37777      │
                                                     └────────────────────┘
```

## Quickstart

```bash
npm install
npm run build
node dist/src/cli.js install     # add the hooks to ~/.claude/settings.json
node dist/src/cli.js serve       # viewer on http://127.0.0.1:37777
```

Open a new Claude Code session, work, end it. The next session in that directory
starts with what the last one learned.

```bash
node dist/src/cli.js status                       # where the store is, what is in it
node dist/src/cli.js list --project orders-sync
node dist/src/cli.js search "why is the nightly sync dropping rows"
node dist/src/cli.js uninstall                    # remove the hooks again
```

## How it works

### 1. Capture — four hooks

`boltmem install` writes four entries into Claude Code's `settings.json`, each one
running `boltmem hook <event>`. Claude Code sends the event as JSON on stdin and
reads JSON back on stdout.

| Hook | When | What boltmem does |
| --- | --- | --- |
| `SessionStart` | session opens (`startup`, `resume`, `clear`) | injects the project's recent memory as `additionalContext` |
| `UserPromptSubmit` | every prompt | searches the store with the prompt, injects matches only when there are any |
| `PreCompact` | before the context window is compacted | extracts from the transcript before it is summarised away |
| `SessionEnd` | session closes | marks the session ended and extracts |

Everything a hook writes to stdout must be one JSON object:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Memory from …"}}
```

Hooks are written so they cannot break a session: `handleHook` catches everything,
logs to `~/.boltmem/boltmem.log`, and returns an empty string. A memory system that
takes down the editor is worse than no memory system.

### 2. Extract — compression, not summary

`SessionEnd` does not run the model inline; it spawns a detached
`boltmem extract` and returns immediately, so nobody waits on a model call to close
a session.

The extractor parses the transcript JSONL (`src/transcript.ts`) into turns, tool
calls and touched files, flattens it into a digest — dropping the middle, keeping
the head and tail, where the goal and the outcome live — and sends it through
`claude -p --output-format json`. The prompt (`src/extract/prompt.ts`) asks for a
JSON array of observations, each one:

```json
{
  "type": "discovery | change | decision | issue",
  "title": "one sentence that reads on its own weeks later",
  "narrative": "two or three sentences of context",
  "facts": ["short standalone statements, checkable against the code"],
  "scope": "subsystem-or-feature",
  "files": ["src/sync/cursor.ts"],
  "keywords": ["extra search terms"]
}
```

The rules in that prompt are most of what separates useful memory from noise: no
pronouns that refer to the conversation, nothing inferred, no routine mechanics,
and an empty array when a session established nothing. Output is validated and
normalised (`src/extract/parse.ts`) — malformed entries are dropped rather than
stored.

**Recursion guard.** The extraction subprocess is itself a Claude Code session, so
it fires the same hooks. It inherits `BOLTMEM_CHILD=1`, and `handleHook` returns
immediately when it sees the flag. Without this the first session end never
terminates.

**Offline fallback.** When the CLI is missing or fails, `src/extract/heuristic.ts`
records what the session touched — goal, edited files, commands — so the timeline
stays continuous. It is deliberately plain; the model pass is the one that writes
anything worth reading. Force either path with `extractor: "claude" | "heuristic"`
in `~/.boltmem/config.json`.

### 3. Store — SQLite + FTS5

One file, `~/.boltmem/boltmem.db`, no server, no embedding model. Node 22's built-in
`node:sqlite` ships FTS5, so there is no native dependency to compile.

`observations` holds the rows; `observations_fts` is an external-content FTS5 index
kept in step by three triggers. Sessions are numbered per project (`Session #95`),
observations globally (`#764`) — the same two counters the viewer shows.

Re-extraction is safe: `content_hash` over (session, type, title) means a session
extracted at `PreCompact` and again at `SessionEnd` stores each finding once.

### 4. Retrieve — BM25, then recency

`searchObservations` takes free text, quotes every token into an FTS5 `MATCH`
expression (so `store.ts OR (NEAR "x"` is text, not syntax), ranks with weighted
BM25 — a title hit outweighs a file-path hit — then re-ranks by age with a 30-day
half-life. A strong match from last week should beat an equally strong one from six
months ago.

Injected memory is labelled as prior notes to verify, not as instructions. It is
model-written text flowing back into a model's context; it should not be able to
give orders.

### 5. Serve — the viewer

A `node:http` server bound to **loopback only**: the store holds whatever your
sessions discussed and nothing authenticates a caller. Static files come from
`src/web` (vanilla JS, no build step), the JSON API is:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/observations?project=&q=&type=&before=&limit=` | recent feed, or search when `q` is set |
| `GET /api/projects`, `GET /api/sessions`, `GET /api/stats` | filters and counters |
| `GET /api/session?id=` | one session with its observations |
| `POST /api/forget?project=` | delete a project's memory |

## Layout

```
src/
  cli.ts              command line entry point
  config.ts           ~/.boltmem/config.json, env overrides, project naming
  hooks/index.ts      one handler per hook event
  transcript.ts       JSONL → turns, tool calls, files, digest
  extract/            prompt, claude -p runner, output parser, offline fallback
  db/                 schema, connection, queries and search ranking
  memory.ts           the text injected into a session
  server/             loopback HTTP API + static viewer
  web/                the viewer itself
test/                 node:test suites for all of the above
```

## Configuration

`~/.boltmem/config.json`, all optional:

```json
{
  "port": 37777,
  "model": "claude-haiku-4-5-20251001",
  "extractor": "auto",
  "maxObservationsPerSession": 12,
  "digestCharBudget": 60000,
  "startContextLimit": 12,
  "injectOnPrompt": true,
  "promptContextLimit": 4,
  "extractTimeoutSec": 180
}
```

`BOLTMEM_HOME`, `BOLTMEM_PORT` and `BOLTMEM_MODEL` override the store directory,
viewer port and extraction model.

## Development

```bash
npm run build      # tsc + copy the viewer assets into dist/
npm test           # build, then node --test over dist/test
npm run typecheck
```

Try the pipeline without touching your real store or a live session:

```bash
BOLTMEM_HOME=/tmp/boltmem-dev node dist/src/cli.js extract \
  --transcript ~/.claude/projects/<project>/<session>.jsonl --dry-run
```

`--dry-run` prints the observations and writes nothing.

## Privacy

Everything is local: one SQLite file, a loopback server, and — when the extractor
runs — transcript text sent to the model through your existing `claude` CLI
credentials. Nothing else leaves the machine. `boltmem forget <project> --yes`
deletes a project's memory outright.

## License

MIT
