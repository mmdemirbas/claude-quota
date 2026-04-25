# Deep review — claude-quota

Date: 2026-04-25
Scope: full source tree at HEAD (post-iteration-2). 292 tests pass.
Lenses: correctness, security, performance, reliability, architecture,
test quality, UX consistency, API contract.

This document lists findings only. None are crisis-level — the codebase
is in good shape after the last two iterations. Items are prioritised
within each lens; a cross-lens severity summary closes the document.

---

## 1. Correctness

### C1. `fetchStartedAt` is now vestigial coordination — usage.ts:152, 194, 380

`bumpCacheTimestamp` writes `fetchStartedAt`; `readCache` checks it
against `FETCH_COORDINATION_MS` to force-fetch if a prior writer died
mid-flight. Since RateLimit-1 added an O_EXCL lock file with the same
stale-reclaim semantics, both mechanisms now solve the same problem.

The bump still has an independent purpose: it shortens `age` on the
cache so peer instances don't see `isStale` and spawn redundant
background refreshers. But the `fetchStartedAt` field itself is dead
weight — its only consumer is the death-detection branch in readCache,
which the lock supersedes.

**Action**: drop `fetchStartedAt` from `CacheFile`, the bump function,
and the readCache death-detection branch. Keep the timestamp bump for
its anti-spawn effect.

### C2. `parseExtraUsage` returns disabled-state with placeholder zeros — usage.ts:336

```ts
if (!raw.is_enabled) return { enabled: false, monthlyLimit: 0, usedCredits: 0, creditGrant: null };
```

The renderer guards this with `if (!enabled)` and never divides, so
`0/0` never happens. But the shape is misleading: a future caller that
forgets the guard would compute `usedPct = (0 / 0) * 100 = NaN`. Cleaner:
return `{ enabled: false }` and tighten the type so `monthlyLimit` /
`usedCredits` are only present when enabled.

Cost: small type-system shuffle. Not urgent.

---

## 2. Security

### S1. Lock file mode depends on umask — usage.ts:436

`fs.openSync(path, O_WRONLY | O_CREAT | O_EXCL, 0o600)` applies
`0o600 & ~umask`. In every realistic umask the result is `0o600`, but
`writeFileSecure` belts and suspenders this with an explicit chmod
after open. The lock file does not.

Risk is theoretical (the plugin dir lives under the user's `~/.claude/`
which is itself user-owned), but consistency matters.

**Action**: `fs.fchmodSync(fd, 0o600)` immediately after `openSync`,
before writing the PID.

### S2. No PID-identity check on stale-lock reclaim — usage.ts:444-454

When we reclaim a stale lock we trust that the on-disk lock is in fact
stale, then unlink + re-create. Between unlink and the second
`tryCreate`, a peer could win — that case is handled (we get null and
yield). But there's no verification that the lock we're unlinking is
the same one we lstat'd: a peer could have released and a new lock been
created in between (with fresh mtime). We'd unlink the new lock.

In practice this race is sub-microsecond and limited to the case where
the previous holder *just* died. The blast radius is "we accidentally
helped the next holder hold their lock through one full
FETCH_COORDINATION_MS without contention" — which is harmless. Noting
for completeness; not worth fixing.

---

## 3. Performance

### P1. `Buffer.byteLength(DASHBOARD_HTML, 'utf8')` recomputed per tick — dashboard.ts:33

The HTML is build-pinned, so its byte length is a constant. The `Perf-2`
optimisation runs the encoder over ~25 KB on every tick to compute a
value that never changes within a process. Lift it to a module-level
const.

Tiny. Order of magnitude: tens of microseconds, ~1× per tick. Worth it
because it's free.

### P2. `getCreditGrant` has no fetch lock — usage.ts:549

The cross-instance lock added in RateLimit-1 covers `fetchApi` only.
`getCreditGrant` makes its own profile + grant fetches. On a cold
start with N parallel Claude windows, all N hit `/api/oauth/profile`
and `/api/oauth/organizations/.../overage_credit_grant` simultaneously.

The TTLs (24 h profile, 10 min / 24 h grant) make this rare in steady
state, but the same trap (rate-limit if many windows open after
upgrade) applies. Symmetry says the credit-grant path should also go
through `acquireFetchLock`.

**Action**: factor the lock acquisition into a helper and apply it to
`getCreditGrant` too. Falling back to the cache (or returning null) on
contention is the same yield strategy.

### P3. Tick I/O budget — informational, no action

Hot path on a cache hit (counted from `main()`):

| op | cost |
|---|---|
| readStdin | microseconds (already-buffered pipe) |
| readJsCache (data.js) | 1 lstat + 1 read |
| readProfileCache | 1 lstat + 1 read |
| readCreditGrantCache | 1 lstat + 1 read |
| getGitStatus | 2 git subprocess invocations |
| ensureDashboardHtml | 1 stat |
| render | no I/O |

Git subprocesses dominate at 10–30 ms each. Caching git state for ~1 s
would skip ~95% of git invocations during sustained typing, but
introduces lag on `git checkout`. Not an obvious win — leave as-is.

---

## 4. Reliability

### R1. Slow-loris tolerance — usage.ts:272, 528 (`req.timeout`)

`https.request({ timeout: 15000 })` arms the **inactivity** timer:
the socket emits `timeout` only if no bytes flow for 15 s. A server
that trickles a single byte every 14 s never trips it. With our 1 MB
body cap and `req.destroy()` on overflow we're bounded by memory, but
the connection — and thus the awaiting Promise — can hang for arbitrarily
long.

If `getUsage` hangs, the entire render is stuck behind `Promise.all` in
`main()`. Claude Code's per-tick timeout (if any) is the only backstop.

**Action**: wrap each request in an absolute-deadline timer:

```ts
const deadline = setTimeout(() => req.destroy(), API_TIMEOUT_MS);
// clear in every resolve path
```

Alternatively: a single `setTimeout(() => abort(), API_TIMEOUT_MS)` in
`fetchApi`/`fetchJson` that destroys the request. Cheap, defensive,
makes the per-instance worst-case bounded.

### R2. `getCreditGrant` cold path makes two serial network calls in the
render's main `Promise.all` — usage.ts:563, 575

Cache miss for both profile and grant: profile fetch, then (after that
returns) grant fetch. Both share R1's slow-loris exposure. Compounds
the worst-case delay.

Mitigation overlaps with R1 — adding the per-request deadline timer
bounds both calls. P2's lock would also gate the cold-start fanout to
one instance.

### R3. `lock.release()` on a forcibly-reclaimed lock — usage.ts:462

If we hold the lock, take longer than `FETCH_COORDINATION_MS`, and a
peer reclaims and acquires, our subsequent `release()` `unlink`s the
peer's lock. Same micro-race as S2; same low blast radius.

Not worth a code change; document the assumption that `fetchApi`
returns within `FETCH_COORDINATION_MS` (it does — `API_TIMEOUT_MS` is
15 s, coordination is 20 s, with 5 s slack).

---

## 5. Architecture

### A1. usage.ts at 738 lines — usage.ts

The file holds: TTL constants, on-disk cache codec, rehydrate helpers,
backoff math, fetch-lock primitive, profile/credit-grant caching, two
HTTP fetchers, schema parsing, the public `getUsage` and
`getCreditGrant`. Each section is well-commented but the file is hard
to navigate by name.

A pragmatic split (no API churn):

- `usage/cache.ts` — readCache, writeCache, recoverCacheState, hydrate
- `usage/api.ts` — collectBody, fetchApi, fetchJson, parsing
- `usage/lock.ts` — acquireFetchLock, bumpCacheTimestamp, jitteredBackoff
- `usage/profile.ts` — readProfileCache, writeProfileCache, getCreditGrant
- `usage.ts` — re-exports + getUsage orchestration

Not urgent. Split when the next feature lands here.

### A2. Cache-file ABI between usage.ts and dashboard.ts is undocumented

`data.js` is `var DATA = <CacheFile>;` and `credit-grant.js` is
`var CREDIT_GRANT = <CreditGrantCacheFile>;`. The dashboard's loader
script imports both via `<script src>` and reads the globals. Changing
the variable names or shape silently breaks the dashboard.

**Action**: extract a `CACHE_VAR_DATA = 'DATA'` const + a structural
comment naming this as a load-bearing ABI. Or test it: a test that
loads the dashboard JS in a vm and asserts the globals are present
already exists for `_esc` (html-escape.test.ts) — extend or add a
companion that pins `DATA`/`CREDIT_GRANT`.

### A3. `index.ts` calls `bumpCacheTimestamp` for the spawn-suppression
side-effect, while `getUsage` calls it for the same side-effect — index.ts:69, usage.ts:667

Two callsites. Not duplication so much as two layers of the same
optimisation. Documented in both. Fine.

---

## 6. Test quality

### T1. No integration test for `getUsage` orchestration

Unit tests cover `clamp`, `parseDate`, `parseExtraUsage`,
`rehydrateDate`, `recoverCacheState`, `acquireFetchLock`,
`jitteredBackoff` — all primitive helpers.

`getUsage` itself — the orchestrator that combines cache reads, lock
acquisition, fetcher dispatch, and result writes — is untested. A
regression in the lock/cache coordination would not be caught by the
current suite.

**Action**: add a focused test that fakes `https` (or factors `fetchApi`
behind a dependency-injection seam) and exercises:

- cache hit → returns cached, no fetch
- cache miss + lock free → fetches, writes cache
- cache miss + lock held by peer → returns cached / yields
- 429 → backoff written; subsequent call within backoff returns last-good
- 500 → preserves prior counter + lastGoodData

The seam is the cleanest of the two options — a `fetchApi` parameter
that defaults to the real one.

### T2. Tier-boundary tests pin absolute column counts — test/render.test.ts

Every layout change shifts the boundaries by ±N. The last iteration
required updating ~10 tests because col0Width grew by 2. The tests
encode the implementation's arithmetic, not its behaviour.

A more robust formulation: derive expected widths from the same
formulae the renderer uses, parametrise tests by tier name, assert
behaviour relative to the tier ("at the full-tier width, branch is
present"; "one column below, branch is absent") with the widths
computed once.

Cost: ~50 lines of test-helper refactor. Pays back with the next
layout change.

### T3. Console.log restoration is inconsistent across tests

`capture()` was hardened with try/finally in M4. Most other render
tests still do raw `const orig = console.log; ...; console.log = orig;`
without try/finally. A future test that throws between those lines
contaminates every test that follows.

**Action**: thread every render-invocation through `capture()` (or
add an internal helper that does the try/finally for the manual
multi-line cases).

---

## 7. UX / rendering consistency

### U1. Disabled extra-usage segment is a fixed 9 chars — render.ts:434

```ts
return `${dim(' ○$:')} ${dim(' off')}`;
```

This was sized to match the **compact** tier (9 chars). At full tier
every other segment is 32 chars; at no-reset 25; at no-pace 19. The
disabled segment doesn't grow to match — line 3 with extras disabled
ends abruptly compared to the wide quota segments next to it.

Two options:

1. Pad to the active detail tier's width. Adds tier awareness to
   `renderExtraUsage`'s disabled branch.
2. Drop the segment entirely except at compact tier. Cleaner — the
   user infers "absent at this tier" instead of seeing a stub.

Option 2 is less work and arguably clearer. Pick whichever; both beat
the status quo.

### U2. apiUnavailable line uses `usage:⟳`/`usage:⚠` prefix — render.ts:672

The rows≥2 + apiUnavailable branch emits a separate line:

```
max │ usage:⟳
```

The rows=1 path emits the bare `⟳` glyph at the right edge. The
rows=2 line-2 / rows=3 line-3 syncHint emits a bare ` ⟳` next to
quotas. Three different presentations of the same status.

**Action**: collapse to one. The bare glyph (rows=1 + syncHint) is
the cleanest; drop the `usage:` prefix in the apiUnavailable line.

### U3. Long project names aren't truncated — stdin.ts:114, render.ts

`getProjectName` returns the basename of `cwd` verbatim. A 60-char
project name would push line 1 layout into compact-tier territory at
quite wide terminals. Tier degradation handles total width but not
per-segment overflow.

Low priority — uncommon in practice. If addressed, truncate
`getProjectName`'s return to e.g. 24 chars with an ellipsis.

---

## 8. API contract / future-proofing

### F1. `UsageData` field optionality is mostly `null`-or-value — types.ts

Every `*ResetAt` field is `Date | null`, every percentage is
`number | null`. The shape is tolerant of API drift. ✓

### F2. Cache-file forward-compat — usage.ts:178 `recoverCacheState`

Old caches missing `lastGoodData` fall through to `prev.data` if it's
healthy. `rateLimitedCount ?? 0`. New `retryAfterUntil` field is
optional and the read-side falls back to count-derived backoff. ✓

The only field whose absence isn't defensively handled:
`cache.fetchStartedAt` — but its branch checks `if (cache.fetchStartedAt
&& ...)` so absence is fine. ✓

### F3. Profile-cache schema migration — usage.ts:482

```ts
if (!cache.rateLimitTier) return null;
```

This forces re-fetch when the cache predates the tier-storage feature.
Good migration shim. Worth noting that this implies a one-time
mandatory profile API hit per upgrade, which adds to P2's cold-start
fanout.

---

## Cross-lens severity

### Medium (worth doing, no rush)

- **R1** — overall request deadline (slow-loris tolerance)
- **P2** — fetch lock for `getCreditGrant`
- **U1** — disabled extra-usage segment misalignment
- **U2** — three presentations of the API status — pick one
- **T1** — `getUsage` orchestration test

### Low (cleanup / fragility)

- **C1** — drop vestigial `fetchStartedAt` (cleanup, makes the lock the single source of truth)
- **C2** — narrower disabled-extra-usage type
- **S1** — `fchmodSync` belt-and-suspenders on lock open
- **A2** — document the `data.js` / `credit-grant.js` ABI
- **A1** — split usage.ts when next change lands
- **P1** — hoist `Buffer.byteLength(DASHBOARD_HTML)` to module const
- **T2** — parametrise tier-boundary tests
- **T3** — try/finally everywhere `console.log` is patched
- **U3** — truncate long project names

### Informational (no action recommended)

- **S2 / R3** — lock-identity races; sub-microsecond and bounded blast radius
- **P3** — git subprocess cost is the dominant cycle; caching has worse trade-offs
