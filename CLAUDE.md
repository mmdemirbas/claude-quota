# claude-quota

Compact statusline plugin for Claude Code showing full usage quota breakdown.

## Project Structure

```
src/
├── index.ts        # Entry point — reads stdin, orchestrates, calls render
├── types.ts        # All type definitions (StdinData, UsageData, etc.)
├── stdin.ts        # Parse JSON stdin from Claude Code
├── credentials.ts  # Read OAuth credentials (macOS Keychain + file fallback)
├── usage.ts        # Fetch api.anthropic.com/api/oauth/usage + file-based cache
├── git.ts          # Git branch and dirty status
└── render.ts       # ANSI status line rendering
```

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
2. Plugin reads OAuth token from macOS Keychain (`/usr/bin/security find-generic-password`)
3. Calls `GET api.anthropic.com/api/oauth/usage` with Bearer token
4. Parses ALL response fields (five_hour, seven_day, seven_day_sonnet, seven_day_opus, extra_usage)
5. Caches response in `~/.claude/plugins/claude-quota/.usage-cache.json` (5 min hard TTL; 2 min soft TTL — stale-while-revalidate spawns background refresh; 15 s on error; exponential backoff on 429)
6. Renders three lines to stdout

## Key Design Decisions

- **Three-line layout**: line 1 = context (model, ctx window, project, git); line 2 = plan + 5h session + 7d all-models; line 3 = fetch time + sonnet + opus + extra usage
- **Pace indicators**: each quota shows current%, directional glyph (↘/→/↗), projected%, and reset countdown
- **Fixed-width columns**: all quota segments (label, bar, value, pace, reset/limit) use the same char widths so glyphs align across lines
- **Fetch time**: `fetchedAt` stored in `UsageData`, rendered as `⟳HH:MM` in the col-0 of line 3 (exact local time, not relative — stays accurate without per-second refresh)
- **Full API parsing**: unlike claude-hud, we parse seven_day_sonnet, seven_day_opus, extra_usage
- **File-based cache**: process is short-lived (~300ms per render), so no in-memory cache
- **Rate-limit resilience**: on 429, show last-good data with ⟳ indicator + exponential backoff

## Conventions

- TypeScript strict mode
- ES modules (type: "module" in package.json)
- No external runtime dependencies — only node built-ins
- ANSI escape codes for colors (no chalk/picocolors)
