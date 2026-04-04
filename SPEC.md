# claude-quota Specification

## Overview

A Claude Code statusline plugin that displays comprehensive usage quota information in a single compact line, eliminating the need to visit the usage settings page.

## Goals

1. Show ALL usage buckets: 5h session, 7d all-models, 7d sonnet, 7d opus, extra usage
2. Single compact line — no multi-line layouts
3. Zero configuration — works out of the box with Claude Code OAuth credentials
4. Zero runtime dependencies — only Node.js built-ins

## Status Line Format

```
[Model | Plan] ████░░░░ ctx% │ project git:(branch*) │ 5h:X%↻time 7d:X% snt:X% $used/$limit
```

### Segments

| Segment | Source | Always shown |
|---------|--------|--------------|
| Model + Plan | stdin.model + credentials.subscriptionType | Yes |
| Context bar | stdin.context_window | Yes |
| Project + git | stdin.cwd + `git rev-parse` | If cwd exists |
| 5h session | API five_hour | If available |
| 7d all-models | API seven_day | If available |
| 7d sonnet | API seven_day_sonnet | If available |
| 7d opus | API seven_day_opus | If available |
| Extra usage | API extra_usage | If enabled |

### Color Thresholds

| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Context | < 70% | 70-85% | ≥ 85% |
| Quotas | < 75% | — | ≥ 90% |
| Quotas (magenta) | — | 75-90% | — |
| Money | $0 | > $0 | ≥ 80% of limit |

## API

**Endpoint**: `GET https://api.anthropic.com/api/oauth/usage`
**Auth**: `Bearer {OAuth access token}`
**Header**: `anthropic-beta: oauth-2025-04-20`

### Response Fields

```json
{
  "five_hour":          { "utilization": 0-100, "resets_at": "ISO8601" },
  "seven_day":          { "utilization": 0-100, "resets_at": "ISO8601" },
  "seven_day_sonnet":   { "utilization": 0-100, "resets_at": "ISO8601" },
  "seven_day_opus":     { "utilization": 0-100, "resets_at": "ISO8601" },
  "seven_day_oauth_apps": null,
  "seven_day_cowork":   null,
  "extra_usage": {
    "is_enabled": true,
    "monthly_limit": 500,
    "used_credits": 0.0,
    "utilization": null
  }
}
```

## Caching Strategy

- Success: 5 min TTL in `~/.claude/plugins/claude-quota/.usage-cache.json`
- Failure: 15s TTL
- Rate-limited (429): exponential backoff 60s → 120s → 240s → 300s max
- During backoff: show last-good data with ⟳ syncing indicator

## Credentials Resolution Order

1. macOS Keychain: `security find-generic-password -s "Claude Code-credentials" -w`
2. File fallback: `~/.claude/.credentials.json`
3. Skip if `ANTHROPIC_BASE_URL` points to non-Anthropic endpoint

## Future Enhancements

- [ ] Configurable segment visibility (env vars or config file)
- [ ] Cowork quota display when available
- [ ] Token speed (tok/s) display
- [ ] Session duration timer
- [ ] npm publish for `claude plugins install` workflow
