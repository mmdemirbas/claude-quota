# claude-quota

Compact, quota-focused statusline plugin for Claude Code. Shows all usage buckets at a glance — no more visiting the usage page.

## What you see

Two lines in your Claude Code statusline:

**Line 1 — context**
```
sonnet high ██░░░░░░ 23% │ lakelab git:(main*)
```

**Line 2 — account**
```
max │ 5h:░░░░ 6%→93% ↺4h41m │ 7d:█░░░ 21%↘70% ↺4d21h │ snt:██░░ 60%→87% ↺2d4h │ $:● $50↘$420/$500
```

### Segments

**Line 1**

| Segment | Meaning |
|---------|---------|
| `sonnet high` | Model family + effort level |
| `██░░░░░░ 23%` | Context window usage (green→yellow→red) |
| `lakelab` | Project directory (last path segment) |
| `git:(main*)` | Git branch, `*` = dirty working tree |

**Line 2**

| Segment | Meaning |
|---------|---------|
| `max` | Plan name (lowercase) |
| `5h:` | 5-hour session quota |
| `7d:` | 7-day all-models quota |
| `snt:` | 7-day Sonnet-only quota |
| `ops:` | 7-day Opus-only quota (if non-zero) |
| `████` | 4-char mini bar per metric |
| `36%` | Current utilization |
| `↘32%` / `→90%` / `↗140%` | Pace glyph + projected end-of-window utilization |
| `↺3h` | Time until quota resets |
| `$:●` | Extra usage enabled (`●`) or disabled (`○`) |
| `$50↘$420/$500` | Current spend, pace, projected / monthly limit |

### Color coding

- **Context bar**: green < 70% → yellow 70–85% → red ≥ 85%
- **Quota bars**: blue < 75% → magenta 75–90% → red ≥ 90%
- **Pace glyph**: green `↘` under-pace · dim `→` on-pace · yellow/red `↗` over-pace
- **Projected**: dim ≤ 79% · yellow 80–100% · red > 100%
- **Money**: green $0 · yellow > $0 · red ≥ 80% of limit

### Pace indicators

Pace compares your current utilization against how far through the window you are:

- `↘` — using less than expected (projected end < 85% of pace)
- `→` — on track (within ±15%)
- `↗` — using more than expected (projected end > 115% of pace)

The number after the glyph is the **projected** utilization at the end of the window at your current rate. Values > 100% mean you are on track to hit the limit.

## Install

### Option A: npm (recommended)

```bash
npm install -g claude-quota
```

Then configure the statusline in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "claude-quota"
  }
}
```

### Option B: from source

```bash
cd ~/.claude/plugins
git clone https://github.com/mdemirbas/claude-quota.git
cd claude-quota
npm install
npm run build
```

Configure the statusline:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /path/to/claude-quota/dist/index.js"
  }
}
```

## Requirements

- macOS (Keychain credential reading)
- Node.js ≥ 18
- Claude Code with an active Pro/Max subscription (OAuth login)
- API key users: usage data is not available via the OAuth endpoint, the plugin will silently skip the quota line

## How it works

1. Claude Code invokes the plugin as a subprocess, piping context JSON on stdin
2. Plugin reads your OAuth token from macOS Keychain (same credential as Claude Code itself)
3. Calls `api.anthropic.com/api/oauth/usage` — response is cached 5 min
4. Renders two lines to stdout

## Replacing claude-hud

If you use `claude-hud`, disable it first to avoid a crowded statusline:

```json
{
  "enabledPlugins": {
    "claude-hud@claude-hud": false
  }
}
```

## Troubleshooting

**No quota line appears** — you may be an API key user, on a free plan, or on a custom `ANTHROPIC_BASE_URL`. The plugin only fetches usage for direct Claude.ai OAuth subscribers.

**`usage:⚠` shown** — the API is unreachable (network error, timeout). Cached data is shown for 15 s, then the warning appears.

**`⟳` indicator** — you hit a rate limit on the usage API. Last-known data is shown with exponential backoff (60 s → 5 min). The `⟳` clears once a fresh fetch succeeds.
