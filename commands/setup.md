# Setup claude-quota

Two-line statusline for Claude Code with full usage breakdown.

## Output

**Line 1** — context:
```
sonnet high ██░░░░░░ 23% │ lakelab git:(main*)
```

**Line 2** — account:
```
max │ 5h:░░░░ 6%→93% ↺4h41m │ 7d:█░░░ 21%↘70% ↺4d21h │ snt:██░░ 60%→87% ↺2d4h
```

## What each metric means

- `sonnet high` — model family + effort level
- `██░░` — 4-char mini bar per quota
- `36%` — current utilization
- `↘32%` / `→90%` / `↗140%` — pace glyph + projected end-of-window value
- `↺3h` — time until reset

## Prerequisites

- macOS with Claude Code credentials in Keychain (standard OAuth login)
- Node.js ≥ 18
- Pro or Max subscription

## No configuration needed

The plugin reads your OAuth credentials automatically from the macOS Keychain. Usage data is cached for 5 minutes to respect API rate limits.
