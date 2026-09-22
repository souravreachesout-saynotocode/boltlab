# boltmem — working notes

boltmem gives Claude Code persistent memory. Hooks capture sessions, an extraction
pass compresses each transcript into observations, SQLite + FTS5 stores them, a
loopback viewer browses them. README.md has the architecture; this file is the
short version of what to keep in mind while changing it.

## Conventions

- TypeScript, ESM, `NodeNext` resolution — imports carry a `.js` extension.
- No runtime dependencies. `node:sqlite` (Node 22.5+) covers storage; adding a
  native module would mean a compile step on every install.
- `npm test` builds first: tests run against `dist/`, not the sources.
- The viewer is vanilla JS in `src/web`, copied into `dist/` by `npm run build`.
  There is no frontend build step on purpose.

## Things that will bite

- **Recursion.** Extraction spawns `claude -p`, which fires the same hooks. The
  child inherits `BOLTMEM_CHILD=1` and `handleHook` bails on it. Keep that check
  first in any new hook path.
- **Hooks must not throw.** A hook that fails takes its behaviour out of a live
  session. Catch, log to `~/.boltmem/boltmem.log`, return an empty string.
- **Hooks must not block.** Session-end extraction is detached
  (`scheduleExtraction`). Anything slower than a database read belongs there, not
  inline.
- **FTS5 syntax.** User text never reaches `MATCH` unquoted — see
  `toMatchExpression`. A stray `(` or `NEAR` in a prompt would otherwise throw.
- **Injected memory is untrusted.** It is model-written text re-entering a model's
  context. It is labelled as notes to verify, never as instructions.
- **Backfilled observations are dated from their transcript**, never from `now()`.
  Recency weighting is half the ranking; dating a backfill today buries everything
  the user has learned since.
- **The server is loopback-only.** No auth, and the store holds whatever sessions
  discussed. Do not add a `--host` flag without adding authentication first.

## Checks before a commit

```bash
npm test
node dist/src/cli.js extract --transcript <some.jsonl> --dry-run   # the model path
```
