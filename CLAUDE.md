# claude-quota

Compact statusline plugin for Claude Code showing full usage quota breakdown.

## Project Structure

Two packages in one repo. The split is the point: measurement is shared with
every other program on the machine, presentation is ours alone.

```
packages/core/          @mmdemirbas/claude-usage — published separately
├── paths.ts            Where the shared directory is
├── types.ts            On-disk protocol shapes + the flat in-memory shape
├── credentials.ts      OAuth token (macOS Keychain + file fallback)
├── api.ts              GET /api/oauth/usage, TLS + deadline policy
├── cache.ts            usage.json: read, write, migrate, shape mapping
├── readings.ts         readings.jsonl: append, read, compact
├── lock.ts             .fetch.lock: the thing that stops duplicate calls
├── profile.ts          Plan tier + prepaid credit balance
├── usage.ts            getUsage() — cache, lock, fetch, record
└── index.ts            Public surface

src/                    @mmdemirbas/claude-quota — the statusline
├── index.ts            Entry point — stdin, orchestration, render
├── types.ts            StdinData, GitStatus; re-exports the rest from core
├── stdin.ts            Parse JSON stdin from Claude Code
├── git.ts              Git branch and dirty status
├── ansi.ts             ANSI-aware string utilities
├── terminal.ts         Terminal dimension resolution
├── render.ts           ANSI status line rendering (width + height adaptive)
├── dashboard.ts        Single-page HTML dashboard generator
└── dashboard-data.ts   data.js / credit-grant.js — derived, for the dashboard
```

**The statusline is a participant, not an owner.** It does not own the usage
numbers; it reads them through `@mmdemirbas/claude-usage` like anything else
on the machine, and fetches only when it is the one that finds them stale. See
`docs/usage-cache-protocol.md` — that file is the contract, and it is written
so a program in another language could join without reading this code.

## Build & Test

```bash
./run build            # tsc → dist/
./run test             # compile test build + run all unit tests
./run stdin            # pipe mock JSON to test output
./run install          # build + npm link (makes global claude-quota binary point here)
./run release [patch]  # bump version, build, test, commit, push, tag → triggers npm publish
```

## How the Plugin Works

1. Claude Code invokes `node dist/index.js` as a subprocess, piping context JSON on stdin
2. `getUsage()` reads `~/.claude/usage/usage.json`. Fresh → serve it, no network, done
3. Stale → take `.fetch.lock`. Lost the lock → a peer is already fetching; re-read and serve
4. Won the lock → read the OAuth token (Keychain, file fallback), `GET /api/oauth/usage`,
   parse every bucket, write the entry, append to `readings.jsonl`
5. Prepaid credit balance comes from profile + credit-grant endpoints on their own caches and locks
6. Renders 1–3 lines to stdout (adaptive to terminal height and width)
7. Writes `data.js`, `credit-grant.js` and `dashboard.html` into
   `~/.claude/plugins/claude-quota/` — derived artifacts for the dashboard page,
   which loads its data with a script tag. Nothing else reads them.
   Open once with `! open ~/.claude/plugins/claude-quota/dashboard.html`

Step 3 is what makes N tools cost one API call instead of N. Every threshold
involved is in `packages/core/src/constants.ts` and documented in the protocol;
a participant that picks its own breaks the arrangement for everyone.

## Key Design Decisions

- **Adaptive height layout**:
  - rows ≥ 3: three-line layout — line 1 = context (model, ctx, project, git); line 2 = plan + 5h + 7d; line 3 = fetch time + sonnet + opus + extra usage
  - rows = 2: two-line — line 1 unchanged; line 2 flattens all quotas (plan + 5h + 7d + snt + ops + $)
  - rows = 1: single line — model + compact ctx% + 5h% + 7d% (no bars, no git)
- **Adaptive width layout**: each line independently degrades through four detail tiers until it fits, with hard truncation as final safety net:
  - full (≥32 chars/quota): bar + pct + pace glyph + projected% + reset timer
  - no-reset (25): drop reset timers
  - no-pace (19): drop pace glyph + projected%
  - compact (9): drop bar, show label + pct only
- **Terminal dimensions**: resolved from `process.stderr` (stays TTY when stdout is piped) → `$COLUMNS`/`$LINES` env vars → defaults (120×3)
- **Pace indicators**: each quota shows current%, directional glyph (↘/→/↗), and projected end-of-window utilization
- **Bar coloring**: filled `█` up to pace is dim; over-pace `█` uses full severity color so excess stands out as actual usage. Empty `░` chars are coloured by outcome — dim for projected-to-be-consumed, gray for wasted quota (projected < 100%), red when quota will run out (projected ≥ 100%)
- **Window-progress glyph**: `○◔◑◕●` replaces `↺` in the reset slot, showing how far into the quota window the current time is (20% steps per glyph)
- **Fixed-width columns**: all quota segments (label, bar, value, pace, reset/limit) use the same char widths so glyphs align across lines
- **Fetch time**: `fetchedAt` stored in `UsageData`, rendered as `⟳HH:MM` in the col-0 of line 3 (exact local time, not relative — stays accurate without per-second refresh)
- **Full API parsing**: unlike claude-hud, we parse seven_day_sonnet, seven_day_opus, extra_usage
- **Credit grant balance**: fetches prepaid credit balance from `/api/oauth/organizations/{orgUUID}/overage_credit_grant` (org UUID from `/api/oauth/profile`). Shown as `($XX.XX)` after the extra usage segment. Both are independently cached with long TTLs since they change rarely.
- **File-based cache**: the process is short-lived (~300 ms per render), so an in-memory cache would never be hit. Everything lives in `~/.claude/usage/`
- **Multi-instance safety**: `O_EXCL` fetch lock with identity-checked release, plus a timestamp bump before the request so peers do not queue their own refresh
- **Rate-limit resilience**: on 429, show last-good data with ⟳ indicator + exponential backoff

## Conventions

- TypeScript strict mode
- ES modules (type: "module" in package.json)
- No external runtime dependencies — node built-ins only, in both packages
- ANSI escape codes for colors (no chalk/picocolors)
- A change to anything in `docs/usage-cache-protocol.md` is a change to a
  contract other programs implement. Update the document in the same commit,
  and bump `SCHEMA_VERSION` when the meaning of an existing field moves.
