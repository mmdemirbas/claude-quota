# Deep review — claude-quota (round 3)

Date: 2026-04-25 (post-iteration-3, all 12 round-2 findings landed).
Scope: full source tree at HEAD. 304 tests pass, build clean.
Lenses: correctness, security, performance, reliability, architecture,
test quality, UX consistency, ABI stability.

The codebase has matured substantially across the last two iterations.
This pass surfaced no critical or high-severity issues. The findings
below are sub-percent improvements over the current quality bar; most
are defensive rather than corrective.

---

## 1. Correctness

### C1. Lock-release identity race — usage.ts:482

`release()` does `fs.unlinkSync(lockPath)` without verifying the file
on disk is still ours:

```ts
return {
  release: () => {
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  },
};
```

Failure mode (rare, narrow):

1. We acquire the lock at t=0, write our PID, close.
2. Our `await fetchApi` runs; meanwhile the process is suspended (laptop
   lid close, heavy GC, OS scheduler delay).
3. At t ≥ FETCH_COORDINATION_MS (20 s), peer B sees the stale mtime,
   reclaims, creates its own lock.
4. At t ≈ 20.5 s, our fetch returns, `release()` runs, and we
   `unlinkSync(lockPath)` — which deletes B's lock, not ours.

Margin to bound this: API_TIMEOUT_MS (15 s) leaves a 5-s window before
FETCH_COORDINATION_MS (20 s). Any mid-fetch suspension > 5 s trips the
race. Real-world frequency: low. Real-world impact: another peer can
then steal the orphaned lock, which means at most two near-simultaneous
fetches — the very thing the lock was supposed to prevent, but only at
roughly 1/N of the fan-out the un-locked code allowed.

**Fix**: write a UUID (or `process.pid` + a random nonce) at acquire,
read it back at release, and only unlink when the contents match.
That tightens the race to a TOCTOU window of microseconds.

```ts
const token = `${process.pid}.${randomBytes(8).toString('hex')}`;
fs.writeSync(fd, token);
…
return {
  release: () => {
    try {
      const onDisk = fs.readFileSync(lockPath, 'utf8');
      if (onDisk === token) fs.unlinkSync(lockPath);
    } catch { /* gone — fine */ }
  },
};
```

### C2. fetchApi `deadline` referenced before initialisation — usage.ts:269, 319

```ts
const finish = (v) => {
  if (settled) return;
  settled = true;
  clearTimeout(deadline);   // referenced here
  resolve(v);
};
…
req.on('error', () => finish({…}));
req.on('timeout', () => { req.destroy(); finish({…}); });
const deadline = setTimeout(…);   // declared here
req.end();
```

Runtime-safe: every code path that calls `finish` runs after `deadline`
is initialised (Node delivers `req.on(*)` events asynchronously, and
`req.end()` is the last synchronous statement). But the closure
references a `const` in its TDZ from the perspective of the source
order, which fails to reflect intent.

**Fix**: declare with `let deadline: NodeJS.Timeout | undefined` before
`finish`, assign after the listeners. Cosmetic; clarifies the
intentional late-binding.

### C3. Retry-After parsing only handles integer seconds — usage.ts:295

```ts
const retryAfterSec = retryVal ? parseInt(retryVal, 10) || undefined : undefined;
```

RFC 7231 allows `Retry-After` to be either an integer-seconds value or
an HTTP-date (`Wed, 21 Oct 2015 07:28:00 GMT`). The current code returns
`undefined` for the date form, then falls back to count-derived
jittered backoff. That's not wrong — backoff still applies — but the
server's hint about when to actually retry is silently ignored.

**Fix**: try `parseInt`; if `NaN`, try `Date.parse`; if valid, compute
seconds-from-now. Two-line addition; correctness improvement.

---

## 2. Security

(No findings worth landing.)

The TLS trust model is documented inline. Cache files are 0o600.
Lock files now go through `fchmodSync` belt-and-suspenders. OAuth
token is CRLF-stripped before headers. Plugin dir is user-owned.
Pre-existing comments cover the model thoroughly.

---

## 3. Performance

### P1. fetchApi / fetchJson duplicate ~50 lines of HTTP+deadline boilerplate — usage.ts:263, 538

Each function:

- Declares `settled` + `finish`
- Builds the same `https.request(…)` options with the same headers
- Wires the same three error/timeout/deadline listeners
- Differs only in the response body handling

Two separate places to keep in sync when adding TLS pinning, retries,
or telemetry. A `requestJson<T>(urlPath, accessToken, statusHandler)`
helper that takes a callback for the status-non-200 branch would
collapse this without changing behaviour.

Net win: ~30 LOC removed, one place to maintain. Not urgent.

### P2. `Buffer.byteLength(DASHBOARD_HTML)` — already addressed, kept as a const ✓

### P3. Lock+bump pair on the cold path — informational

Cold path now performs:

1. `acquireFetchLock` (open + fchmod + write + close, ~4 syscalls)
2. `bumpCacheTimestamp` (read + parse + write of data.js, 2-3 syscalls)
3. `await fetchApi`
4. `lock.release()` (unlink, 1 syscall)
5. `writeCache` (writeFileSecure: open + write + fsync + chmod + rename)

Each "syscall" is sub-millisecond on local disk. The bump is the most
questionable now — its only role is to suppress redundant background
spawns by other parents. The lock alone correctly serialises the
fetch. Removing the bump would save one read+parse+write per cold
path per process. The trade-off is more spawn churn under contention.

Recommendation: leave as is. The bump's role is documented; cost is
~1 ms; benefit is real (avoids ~50–100 ms of node startup × N parents).

---

## 4. Reliability

### R1. R1's deadline-timer fix has no test — usage.ts:319

The slow-loris deadline is a defensive change with no regression
test. Future code that refactors `fetchApi` (e.g., the P1 dedup
above) could quietly drop the deadline without the suite noticing.

**Fix**: add a test using `http.createServer` that responds with one
byte every (API_TIMEOUT_MS + small) seconds and assert that
`fetchApi` resolves with `error: 'timeout'` within bounded time. The
test already-imports `node:http` machinery in render.test.ts and
getUsage.integration.test.ts, so cost is moderate.

Alternative: mock `https.request` via a DI seam similar to the
`fetcher` option on `getUsage`. Smaller blast radius but doesn't
exercise the actual timeout plumbing.

### R2. `getCreditGrant` populates the profile cache as a side-effect

Cold path order in index.ts:

```ts
Promise.all([
  getUsage(),
  …,
  getCreditGrant(),
])
```

`getUsage` calls `livePlanName()`, which prefers the profile cache;
if absent, falls back to credentials. `getCreditGrant` is what
populates that cache (when it has to fetch profile). On a fresh
install both run in parallel, so `getUsage` always sees the empty
profile cache and falls back to credentials. The plan name from
credentials may be stale after a plan upgrade until Claude Code
refreshes the OAuth token.

Net impact: the *first* render after a plan upgrade may show the old
plan name. After that, getCreditGrant has populated the cache, and
subsequent renders are correct.

**Fix**: order `getCreditGrant` before `getUsage`, or have `getUsage`
itself trigger the profile fetch when the profile cache is missing.
Both are non-trivial; weigh against the rarity of the situation
(plan upgrade is once per account).

Could be left alone — it's a documented limitation with a self-
healing recovery within ~10 min on subsequent renders.

---

## 5. Architecture

### A1. dashboard.ts JS body still uses `DATA` / `CREDIT_GRANT` literally — dashboard.ts:400, 422

A2 from the previous round wired the loader (top of LOADER block) to
interpolate `${CACHE_VAR_DATA}` / `${CACHE_VAR_CREDIT_GRANT}`. The
**body** of the JS — `renderDashboard()` and friends — still uses
the hardcoded names:

```js
function renderDashboard() {
  if (!DATA || !DATA.data) return;
  var raw = DATA.lastGoodData || DATA.data;
  …
}
```

The pinning test added in A2 keeps the constants stable so the
literals remain valid. This is documented; the divergence is a known
trade-off (rewriting the JS body to interpolate every reference would
hurt readability significantly).

Noted for future readers. No action.

### A2. Dashboard JS template: 350 lines of inline JS, no source maps

`dashboard.ts` is 817 lines, ~70% of which is a CSS template + a JS
template assembled via `${…}` into the HTML. The shipped output is a
single file that the dashboard reloads on the user's browser. Debugging
a runtime error in the dashboard means reading the rendered HTML in
DevTools without source-map attribution.

Pragmatic alternative: move the CSS and JS into separate `.ts` files
exported as `const CSS = '…'` and `const JS = '…'` strings (manual
templates), assembled by `dashboard.ts`. Same shipping shape; better
in-IDE syntax highlighting and per-file size limits.

Bigger-still alternative: ship `dashboard.css` and `dashboard.js` as
separate files written next to `dashboard.html`. Removes the assembly
step entirely. Has a multi-file write (3 instead of 1) which is fine.

Either is a refactor for a quieter week. Today's structure works.

### A3. usage.ts at 792 lines — reiteration

Same observation as the previous review. The recent additions
(rehydrateDate, recoverCacheState, jitteredBackoff, acquireFetchLock,
collectBody, both fetchers) keep growing it. A natural split would
be: `cache.ts` (read/write/recoverCacheState), `lock.ts`
(acquireFetchLock + bumpCacheTimestamp + jitteredBackoff), `api.ts`
(fetchApi + fetchJson + collectBody + parsing helpers), main module
(getUsage + getCreditGrant orchestration).

Not urgent. Land it the next time a substantive feature touches this
file.

---

## 6. Test quality

### T1. T2's parametrisation introduced a `LINE2.full = 83` constant
that the suite computes from QUOTA_TIER_WIDTH. The renderer's own
`TIER_SEGMENT_WIDTH` lives in `render.ts` and is not exported. So the
test recomputes the same numbers from a duplicated literal table.

If TIER_SEGMENT_WIDTH ever changes in render.ts and not the test,
the suite will silently fail on actual content while passing on
"expected width matches our literal". That's the kind of drift T2
was meant to prevent.

**Fix**: export `TIER_SEGMENT_WIDTH` from render.ts and import it in
the test instead of redefining it. One line of import; deletes the
test's literal copy.

### T2. The R1 deadline timer has no test (cross-listed at R1).

### T3. Integration test takes ~750 ms — informational

`getUsage.integration.test.ts` runs in ~750 ms because each subtest
invokes `readCredentials`, which on macOS spawns `/usr/bin/security`
(Keychain lookup) and waits up to 3 s. Works fine in CI; just slow on
local machines that have real Keychain entries.

A `CLAUDE_QUOTA_SKIP_KEYCHAIN=1` env flag honoured by `readFromKeychain`
would let the integration test bypass Keychain entirely and rely on
the planted file. Adds an env flag for test speed; consider only if
this becomes annoying.

---

## 7. UX / rendering consistency

### U1. `apiHint` is computed before the rows-branching but only used
in the rows=1 branch — render.ts:545

```ts
const apiHint = usage?.apiError === 'rate-limited'
  ? dim(' ⟳')
  : usage?.apiUnavailable
    ? c(YELLOW, ' ⚠')
    : '';
const apiHintW = visibleLength(apiHint);

if (rows === 1) {
  …  // uses apiHint + apiHintW
} else {
  …  // doesn't use either
}
```

The rows≥2 branch uses its own `syncHint` definition further down
(line 620), which differs subtly: syncHint is only set for
'rate-limited' (no ⚠ for failures, because rows≥2 falls through to
the explicit `else if (apiUnavailable)` branch). apiHint covers both.

Two parallel definitions of "what to show when API is unhappy" is
itself a small drift opportunity. Consolidate: one helper
`apiStatusHint(usage)` returning `{ glyph, visibleWidth }`, used by
both rows=1 and the rows≥2 syncHint slot.

### U2. Disabled extra-usage placeholder hardcodes the visible width 9 — render.ts:438

```ts
const placeholder = `${dim(' ○$:')} ${dim(' off')}`; // 9 visible chars
…
return placeholder + ' '.repeat(Math.max(0, target - 9));
```

The literal 9 is the comment's word, not the code's. If someone
changes the placeholder text (e.g., adds a glyph), the padding
arithmetic silently miscalculates. Replace with
`visibleLength(placeholder)`. Self-correcting.

---

## 8. ABI stability

(No findings.)

A2 from the last round set up the constants and a pinning test.
Nothing has drifted since.

---

## Cross-lens severity

### Medium (worth landing)

- **C1** — Lock-release identity check (UUID/PID + verify-on-unlink)
- **R1/T2** — Test for the slow-loris deadline timer
- **U1** — Consolidate `apiHint` / `syncHint` into one helper
- **C3** — Honour HTTP-date Retry-After format

### Low (cleanup)

- **C2** — `let deadline` declared before `finish` (TS clarity)
- **P1** — Refactor fetchApi/fetchJson around a shared helper
- **T1** — Export TIER_SEGMENT_WIDTH from render.ts; drop test's copy
- **U2** — Use `visibleLength(placeholder)` instead of literal 9
- **R2** — Reorder `getCreditGrant` before `getUsage` in main()

### Informational (no action)

- A1 — dashboard.ts JS body literals (documented trade-off)
- A2 — dashboard.ts JS template structure (large refactor)
- A3 — usage.ts size (split when next feature lands here)
- P3 — lock+bump cost on cold path (correct trade-off)
- T3 — integration test speed (acceptable)
