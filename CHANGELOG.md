# Changelog

## Unreleased

### Added
- Projected-use bar coloring: the empty portion of each quota/money bar is now coloured to
  communicate end-of-window outlook — red `░` when projected ≥ 100% (quota will be exhausted),
  gray `░` for wasted area beyond projected usage when projected < 100%
- Window-progress glyph: reset countdown symbol `↺` replaced with a filled-circle glyph
  (`○◔◑◕●`) that shows how far into the quota window the current time is (20% steps)
- Adaptive width rendering: each output line independently degrades through four detail tiers
  (full → no-reset → no-pace → compact) until it fits within the terminal width, with hard
  truncation as a final safety net — prevents garbling on narrow terminals
- Adaptive height rendering: three height tiers based on available rows:
  - rows ≥ 3: standard 3-line layout (unchanged default)
  - rows = 2: line 1 unchanged; line 2 merges all quotas (5h + 7d + snt + ops + $)
  - rows = 1: single summary line — `model │ ctx% │ 5h% │ 7d%` (no bars, no git)
- `src/ansi.ts`: `visibleLength()` and `truncate()` — ANSI-aware string measurement and truncation
- `src/terminal.ts`: terminal dimension resolution (stderr TTY → `$COLUMNS`/`$LINES` → 120×3)
- Line 1 git info degrades gracefully: `project + branch*` → `project only` → omitted
- 163 unit tests (up from 100)

### Fixed
- Rate-limited indicator (⟳) could push output lines 2 chars past the terminal width because
  it was appended after `fitLine` already sized the line to `cols`; `fitLine` now receives
  `cols − syncHintWidth` so the combined output never wraps
- `formatMoney` produced 5-char strings for sub-dollar amounts (e.g. `$0.50`), overflowing the
  4-char value field in `renderExtraUsage` and breaking column alignment; sub-dollar amounts
  now render as `$.XX` (exactly 4 chars); $1000+ renders as `$Nk`
- `resetIn` produced strings up to 6 chars (e.g. `22h49m`) which overflowed the 5-char slot
  in `renderQuota`, shifting the `│` separators on line 3 out of alignment with line 2; minor
  unit (minutes or hours) is now dropped when the full format would exceed 5 chars
- CRLF characters in OAuth access token stripped in `parseCredentials` to prevent HTTP header
  injection if the token reaches an Authorization header
- Non-numeric `expiresAt` in credentials file (e.g. a date string) would bypass expiry check
  via NaN comparison; guarded with `typeof expiresAt !== 'number'`
- Cache file symlink attack: `writeCache` now refuses to write through a symbolic link

## 0.2.2 — 2026-04-04

### Added
- Stale-while-revalidate cache: after 2 min a detached background process refreshes usage data so
  quota metrics stay current during long sessions (hard TTL remains 5 min)
- `run` script with subcommands: `build`, `test`, `lint`, `dev`, `stdin`, `install`, `release`
- `./run install` builds and links the repo as the global `claude-quota` binary
- `./run release [patch|minor|major]` bumps version, builds, tests, commits, pushes, and creates
  the `v*` tag that triggers npm publish

## 0.2.1 — 2026-04-04

### Added
- GitHub Actions CI workflow: lint + test on Node 20 and 22, triggers on push to main and PRs
- GitHub Actions publish workflow: lint + test + `npm publish --provenance` on `v*` tags
- ESLint with `typescript-eslint` recommended rules (`npm run lint`)

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
