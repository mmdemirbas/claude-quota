# claude-quota Specification

## Overview

A Claude Code statusline plugin that displays comprehensive usage quota information across two compact lines, eliminating the need to visit the usage settings page.

## Goals

1. Show ALL usage buckets: 5h session, 7d all-models, 7d sonnet, 7d opus, extra usage
2. Two-line layout: context (line 1) + account/quota (line 2)
3. Pace indicators: show current utilization, directional glyph, and projected end-of-window value
4. Zero configuration — works out of the box with Claude Code OAuth credentials
5. Zero runtime dependencies — only Node.js built-ins

## Status Line Format

**Line 1**
```
sonnet high ████░░░░ 79% │ lakelab git:(main*)
```

**Line 2**
```
max │ 5h:████░░░░ 36%→90% ↺1h55m │ 7d:██░░░░ 18%↘32% ↺4d22h │ snt:████████ 56%→82% ↺4d22h
```

### Segments

**Line 1**

| Segment | Source | Always shown |
|---------|--------|--------------|
| `family effort` | stdin.model.display_name + stdin.effort_level | Yes |
| Context bar | stdin.context_window | Yes |
| ctx% | stdin.context_window | Yes |
| Project name | stdin.cwd (last path segment) | If cwd exists |
| git:(branch*) | `git rev-parse` | If inside a git repo |

**Line 2**

| Segment | Source | Always shown |
|---------|--------|--------------|
| Plan name (lowercase) | credentials.subscriptionType | If usage available |
| 5h: bar pct%glyph projected% ↺reset | API five_hour | If available |
| 7d: bar pct%glyph projected% ↺reset | API seven_day | If available |
| snt: bar pct%glyph projected% ↺reset | API seven_day_sonnet | If available |
| ops: bar pct%glyph projected% ↺reset | API seven_day_opus | If non-zero |
| $:● bar $spent glyph $projected/$limit | API extra_usage (enabled) | If enabled |
| $:○ | API extra_usage (disabled) | If disabled |

### Pace Calculation

For each quota window (5h or 7d):
```
elapsedFraction = (windowMs - remaining) / windowMs
projected       = round(currentPct / elapsedFraction)
paceRatio       = currentPct / (elapsedFraction × 100)
```

Glyph assignment:
- `↘` (green)  — paceRatio < 0.85
- `→` (dim)    — 0.85 ≤ paceRatio ≤ 1.15
- `↗` (yellow/red) — paceRatio > 1.15

Pace is suppressed when < 2% of the window has elapsed (to avoid meaningless early projections).

### Color Thresholds

| Metric | Threshold | Color |
|--------|-----------|-------|
| Context | < 70% | green |
| Context | 70–85% | yellow |
| Context | ≥ 85% | red |
| Quotas | < 75% | bright blue |
| Quotas | 75–90% | bright magenta |
| Quotas | ≥ 90% | red |
| Projected | ≤ 79% | dim |
| Projected | 80–100% | yellow |
| Projected | > 100% | red |
| Money bar | 0% | dim |
| Money bar | > 0% | yellow |
| Money bar | ≥ 80% | red |
| Money value | $0 | green |
| Money value | > $0 | yellow |
| Money value | ≥ 80% of limit | red |

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
  "extra_usage": {
    "is_enabled": true,
    "monthly_limit": 500,
    "used_credits": 0.0
  }
}
```

## Caching Strategy

| Condition | TTL | Behavior |
|-----------|-----|----------|
| Success | 5 min | Normal display |
| Network/parse failure | 15 s | Show `usage:⚠` |
| Rate-limited (429) | 60 s → 120 s → 240 s → 300 s (exponential) | Show last-good data + `⟳` |

Cache file: `~/.claude/plugins/claude-quota/.usage-cache.json`

## Credentials Resolution Order

1. macOS Keychain: `security find-generic-password -s "Claude Code-credentials" -w`
2. File fallback: `~/.claude/.credentials.json`
3. Skip if `ANTHROPIC_BASE_URL` points to a non-Anthropic endpoint

## Constraints

- macOS only (Keychain)
- OAuth subscribers only (Pro/Max plans)
- No external runtime dependencies

## Future Enhancements

- [ ] Linux credential support
- [ ] Configurable segment visibility (env vars)
- [ ] Cowork quota display when available
- [ ] Token speed (tok/s) display
