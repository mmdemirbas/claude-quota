# Changelog

## 0.2.0 — 2026-04-04

### Added
- Two-line layout: line 1 for context (model, context window, project, git), line 2 for account (plan, quotas)
- Pace indicators per quota: directional glyph (↘ under / → on / ↗ over) + projected end-of-window utilization
- 4-character mini bars per quota metric
- `│` separator between quota metrics
- `↺` reset countdown symbol
- `●`/`○` symbols for extra usage enabled/disabled state
- Model display as `family effort` (e.g. `sonnet high`) instead of compact code
- `getEffortLevel` reads both `effort_level` (snake_case) and `effortLevel` (camelCase) from stdin
- `calcPace`, `resetIn`, `formatMoney`, `modelDisplay` exported for unit testing
- 83 unit tests across 16 suites covering render helpers, pace calculation, stdin parsing, usage parsing

### Fixed
- Rate-limit backoff state lost across invocations (outer `writeCache` overwrote backoff data)
- `setTimeout` event loop leak causing 2-second hang after stdin ends normally
- `res.statusCode` could be `undefined`, producing `"http-undefined"` error code
- `extractFamily` matched `3` instead of `sonnet` for "Claude 3.5 Sonnet" format
- Pace projection non-determinism in tests (threaded `now` parameter through render pipeline)

### Changed
- Plan name lowercased in display (`Max` → `max`)
- Refresh symbol `↻` → `↺`
- `parseExtraUsage` returns `{enabled: false, ...}` instead of `null` so render can show `○`

## 0.1.0 — initial release

- Basic single-line status bar: model, context window, project, git, quota percentages, extra usage
