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
npm run build          # tsc → dist/
npm run test:stdin     # pipe mock JSON to test output
```

## How the Plugin Works

1. Claude Code invokes `node dist/index.js` as a subprocess, piping context JSON on stdin
2. Plugin reads OAuth token from macOS Keychain (`/usr/bin/security find-generic-password`)
3. Calls `GET api.anthropic.com/api/oauth/usage` with Bearer token
4. Parses ALL response fields (five_hour, seven_day, seven_day_sonnet, seven_day_opus, extra_usage)
5. Caches response in `~/.claude/plugins/claude-quota/.usage-cache.json` (5 min TTL)
6. Renders single-line status bar to stdout

## Key Design Decisions

- **Single status line**: no expanded/compact modes, no config file system — keep it simple
- **Full API parsing**: unlike claude-hud, we parse seven_day_sonnet, seven_day_opus, extra_usage
- **File-based cache**: process is short-lived (~300ms per render), so no in-memory cache
- **Rate-limit resilience**: on 429, show last-good data with ⟳ indicator + exponential backoff

## Conventions

- TypeScript strict mode
- ES modules (type: "module" in package.json)
- No external runtime dependencies — only node built-ins
- ANSI escape codes for colors (no chalk/picocolors)
