# Usage cache protocol, version 1

A file protocol for sharing Claude subscription usage readings between
independent programs on one machine.

The problem it solves: `GET /api/oauth/usage` is rate limited, and every tool
that wants to show quota wants the same numbers. Without coordination, N tools
means N times the request rate, and the endpoint answers 429. With this
protocol, whichever tool asks first fetches, and the rest read what it wrote.

No participant needs to know that any other participant exists. There is no
daemon, no socket, no leader election, and no tool that must be installed for
another to work. A participant that finds a fresh reading serves it; a
participant that finds none fetches one itself.

The reference implementation is `@mmdemirbas/claude-usage`. This document
exists so a second implementation, in any language, is possible without reading
that code.

---

## 1. Location

```
$CLAUDE_CONFIG_DIR/usage/
```

`CLAUDE_CONFIG_DIR` defaults to `~/.claude`, matching the resolution Claude Code
itself uses. The directory is created mode `0700` on first write.

The config directory is the account boundary: the OAuth credentials that
authorise the fetch live under the same root, so a participant pointed at a
different `CLAUDE_CONFIG_DIR` reads a different account's usage and must not
share a cache with the first. Deriving the cache location from the config
directory makes that automatic rather than something each participant has to
remember.

| File | Mode | Purpose |
|---|---|---|
| `usage.json` | `0600` | The current entry: newest reading, last good reading, backoff state |
| `readings.jsonl` | `0600` | Append-only log of distinct successful readings |
| `.fetch.lock` | `0600` | Mutual exclusion for the upstream fetch |

The reference implementation keeps two more files in the same directory —
`profile.json` and `credit-grant.json`, with `.profile.lock` and
`.credit-grant.lock` beside them. They hold a plan label and a prepaid balance
rather than a measurement, so they are outside this protocol (§8); they live
here only so a second participant does not re-fetch them either. Nothing in
this document depends on them, and an implementation may ignore them.

A participant MUST refuse to read any of these if the file is a symbolic link,
is not owned by the current uid, or has any group or world permission bit set.
A refused file is treated as absent. Without this a second local user can plant
a `usage.json` and drive another user's tooling.

---

## 2. `usage.json`

```jsonc
{
  "schemaVersion": 1,
  "timestamp": 1787519955100,   // unix ms; when this entry was last written or bumped
  "reading":  { /* Reading */ } | null,
  "lastGood": { /* Reading */ } | null,
  "backoff": {
    "rateLimitedCount": 0,
    "retryAfterUntil": null     // unix ms, or null
  }
}
```

- `reading` is the newest outcome, success **or** failure. A failure carries
  `error` and null utilizations.
- `lastGood` is the newest *successful* reading. It survives failures so a
  participant can keep showing real numbers during an outage instead of
  blanking. When `reading` is a success, `lastGood` is the same object.
- `timestamp` is not always `reading.fetchedAt`: a participant about to fetch
  bumps `timestamp` first (§5), which suppresses duplicate refresh attempts by
  peers without claiming a reading that has not arrived yet.

Unknown top-level keys MUST be preserved on write. A participant running an
older implementation must not silently delete fields a newer one added.

### 2.1 Reading

```jsonc
{
  "fetchedAt": 1787519955100,
  "planName": "Max 20x",
  "buckets": {
    "fiveHour":         { "utilization": 5, "resetsAt": "2026-08-24T01:00:00.436Z" },
    "sevenDay":         { "utilization": 8, "resetsAt": "2026-08-30T15:00:00.436Z" },
    "sevenDaySonnet":   null,
    "sevenDayOpus":     null,
    "sevenDayDesign":   null,
    "sevenDayRoutines": null,
    "sevenDayCode":     null
  },
  "extraUsage": { "enabled": false },
  "error": null
}
```

`buckets` is an open map, deliberately. Anthropic adds quota buckets under
internal codenames (`cowork`, `omelette`, `oauth_apps`) without notice. A map
means a newer participant can record a bucket an older one has never heard of,
the older one ignores it, and nothing is lost from the file — where a fixed
field list would require a schema version bump for every new bucket.

Bucket keys defined by version 1:

| Key | API field | Window |
|---|---|---|
| `fiveHour` | `five_hour` | 5 h |
| `sevenDay` | `seven_day` | 7 d |
| `sevenDaySonnet` | `seven_day_sonnet` | 7 d |
| `sevenDayOpus` | `seven_day_opus` | 7 d |
| `sevenDayDesign` | `seven_day_cowork` | 7 d |
| `sevenDayRoutines` | `seven_day_oauth_apps` | 7 d |
| `sevenDayCode` | `seven_day_omelette` | 7 d |

A bucket value is `null` when the API omitted it. `utilization` is an integer
0–100. `resetsAt` is an ISO 8601 instant in UTC, or `null`.

The codename-to-label mapping is inferred from `claude.ai/settings/usage`, not
documented by Anthropic. It is metadata about presentation and belongs to the
participant, not to this file.

`error` is `null` on success, otherwise one of `rate-limited`, `network`,
`timeout`, `parse`, or `http-<status>`.

`extraUsage` is `null` when the API omitted it, `{"enabled": false}` when extra
usage is off, otherwise `{"enabled": true, "monthlyLimit": <dollars>,
"usedCredits": <dollars>, "creditGrant": <dollars>|null}`. Dollars, not the
API's minor units.

---

## 3. `readings.jsonl`

One JSON `Reading` per line, appended in `fetchedAt` order, successes only.
This is what makes a curve — and any projection worth believing — possible:
the API has no history endpoint and answers only "right now".

- Append with a single `O_APPEND` write per line, so concurrent appenders
  cannot interleave partial lines.
- Append only under the fetch lock (§4), and only for a reading whose
  `fetchedAt` is greater than the last line's. Two participants therefore never
  write the same reading twice.
- A reader MUST skip lines it cannot parse rather than failing. A torn final
  line from an interrupted write is expected and is not corruption of the rest.

### 3.1 Compaction

The log is a shared convenience, not an archive. A participant that needs
unbounded history keeps its own store.

Two bounds apply, and they are not equals:

| Bound | Value | Force |
|---|---|---|
| Retention | 30 days | Preference — what we would like to keep |
| Size cap | 4 MB | Hard — what the file may cost every other participant |

When the file exceeds the size cap after an append, the holder of the fetch
lock rewrites it atomically, via temp file and rename. It first drops readings
older than the retention window. **If the result still exceeds the cap, it
drops the oldest survivors until it fits**, leaving headroom so the next append
does not immediately re-trigger.

That second step is required, not an optimisation. At the highest sustainable
fetch rate — one reading per hard TTL, 720 a day at roughly 350 bytes — 30 days
is about 7 MB. An implementation that only dropped by age would remove nothing,
stay over the cap, and compact again on the very next append, rewriting several
megabytes every couple of minutes for as long as the machine is in use. Every
compaction MUST end under the cap, so that progress is guaranteed.

Compaction happens under the lock, so no append can be lost to it.

---

## 4. `.fetch.lock`

Mutual exclusion for the upstream request. This is the part that actually
prevents the redundant calls.

**Acquire.** `open(O_CREAT | O_EXCL | O_WRONLY, 0600)`. On success, write a
per-acquisition token — `<pid>.<16 hex chars of CSPRNG>` — and close. If the
token cannot be written, or the file cannot be closed, unlink the lock and
report failure: a lock whose contents are not the token can never be released
by its owner, and would block every participant for the full staleness window.

On `EEXIST`, `lstat` the lock. A symlink is neither followed nor honoured —
remove it, warn, and retry. If the mtime is newer than **20 000 ms**, a live
participant holds it and the caller did not get the lock. Older than that, the
holder is presumed dead and the lock may be **reclaimed**, as follows.

**Reclaim.** Reclaiming is a read-modify-write across processes — decide the
lock is stale, remove it, create a new one — and POSIX offers no way to do that
atomically. Both obvious implementations have a measured race:

| Attempt | How it fails | Measured |
|---|---|---|
| stat → unlink → create | Two participants both see the stale lock; the second unlink deletes the first's *brand-new* lock | 1 double-holder in 20 trials |
| rename aside → create | A third participant, holding a stat from before that rename, renames the *winner's fresh* lock aside and puts it back; a create lands in the gap | 1 double-holder in 15 trials |

So reclaim MUST be serialised rather than made clever. A participant:

1. Takes a second lock at `<lockpath>.reclaim`, with `O_EXCL` only. Failure to
   take it means yield — unless it is itself older than 20 000 ms, in which case
   its holder is certainly gone (the sequence below takes microseconds) and it
   may be removed.
2. **Re-checks the main lock's mtime under that lock.** Anything acquired since
   the first stat was acquired legitimately and MUST be left alone. This is the
   step that makes the scheme safe.
3. Unlinks the main lock and creates it with `O_EXCL`. If that create fails, a
   plain acquire won the gap; yield to it.
4. Removes the reclaim lock.

Every path ends with at most one holder.

**Release.** Read the file back. Unlink **only if** the contents equal the token
written at acquire.

The identity check is load-bearing. A holder whose event loop was suspended
past the staleness threshold has its lock legitimately reclaimed by a peer; on
resume, an unconditional unlink would delete the *peer's* lock and hand the
file back to the thundering herd the lock exists to prevent.

**20 000 ms** must stay above the API timeout (15 000 ms), or a fetch still in
flight has its lock stolen.

**A participant that fails to acquire the lock MUST NOT fetch.** It re-reads
`usage.json` — the winner may have finished in the meantime — and serves
whatever is there, or nothing.

---

## 5. Freshness and backoff

All participants use the same thresholds, or the protocol does not hold: a tool
with a shorter TTL fetches while its peers consider the cache fresh, which is
exactly the redundant traffic this exists to stop.

| Constant | Value | Meaning |
|---|---|---|
| Hard TTL | 120 000 ms | Older than this, the entry is not served; fetch. |
| Soft TTL | 90 000 ms | Older than this, serve it but report `isStale`. |
| Failure TTL | 15 000 ms | A non-429 failure entry is retried this soon. |
| Lock staleness | 20 000 ms | §4. |
| 429 base backoff | 60 000 ms | Doubled per consecutive 429. |
| 429 max backoff | 600 000 ms | Ceiling on the doubling. |
| 429 jitter | ±20 % | Multiplicative, applied to the derived backoff. |
| Retry-After cap | 24 h | Ceiling on any `retryAfterUntil`, however derived. |

**Read.** Given `now`:

1. No file, unreadable, refused by the safety check, or `schemaVersion` greater
   than the implementation understands → nothing cached.
2. `reading.error == "rate-limited"` and `backoff.rateLimitedCount > 0` → in
   backoff until `min(retryAfterUntil ?? timestamp + derivedBackoff, timestamp +
   24h)`. Before that instant: serve `lastGood` marked rate-limited, never
   fetch. After it: treat as nothing cached.

   **"Never fetch" admits no exception, including an explicitly forced
   refresh.** A participant that offers a force/refresh entry point MUST check
   the backoff there too. Anything on the machine can invoke such an entry
   point, so this cannot be left to callers being careful — and each request
   made inside an active backoff escalates `rateLimitedCount` for every
   participant, not just the one that made it.
3. Otherwise, with `ttl` = failure TTL when `reading.error` is set, hard TTL
   when it is not: serve if `|now - timestamp| < ttl`, with `isStale` set when
   `|now - timestamp| >= softTtl` and the reading is a success.

   The magnitude is deliberate. An entry written while the machine's clock was
   fast — VM resume, RTC drift, a manual change — is stamped in the future, and
   a plain subtraction then yields a negative age: smaller than any TTL, so
   every participant serves that reading as fresh and never marks it stale, for
   as long as the skew lasts. Measured at an hour of skew: fresh for the whole
   hour. Taking the magnitude makes a future-dated entry read as old, so the
   next participant refetches and the entry heals.

   **When `reading.error` is set and `lastGood` is present, serve `lastGood`**
   with the error attached, whatever the error was. Blanking a quota display
   over one HTTP 500, with a twenty-second-old reading on disk, discards
   information the participant is still holding — which is the situation
   `lastGood` exists for (§2).

**Bump before fetch.** A participant that has taken the lock rewrites
`usage.json` with `timestamp = now` and everything else unchanged, *before*
issuing the request. Peers reading during the flight see a fresh entry and do
not queue their own refresh. The reading itself is untouched, so nobody is told
a number that was not measured.

"Everything else unchanged" is literal, and it is easy to get wrong: a
participant that re-serialises its *parsed* representation of the entry will
drop any field it does not model. Entry-level keys are easy to preserve; keys
nested inside `reading` and `lastGood` are the ones that get lost. Edit the
timestamp on the raw JSON.

**A participant MUST NOT bump without holding the lock.** The bump is a
read-modify-write, and performing it unlocked lets it replace a peer's freshly
written reading with an older one under a new timestamp — which then survives
for a full hard TTL it did not earn.

**429.** Increment `rateLimitedCount`, set `retryAfterUntil` from the server's
`Retry-After` when present, otherwise to `now + jitteredBackoff(count)`.
Preserve `lastGood`.

Jitter is not decoration. Without it, every participant coming off the same
count computes the same retry instant, wakes together, and re-triggers the same
429 in lockstep.

**Non-429 failure.** Write the failure as `reading`, leave `rateLimitedCount`
and `lastGood` alone, so a 429 arriving after an intermittent 500 still finds
its escalation state.

**Success.** Write `reading` and `lastGood` to the new reading, reset
`rateLimitedCount` to 0 and `retryAfterUntil` to null, and append to
`readings.jsonl`.

---

## 6. Fetching

`GET https://api.anthropic.com/api/oauth/usage`

```
Authorization: Bearer <accessToken>
anthropic-beta: oauth-2025-04-20
```

The token is Claude Code's own OAuth credential, from exactly one of:

- macOS Keychain, service `Claude Code-credentials` when the config directory is
  the default `~/.claude`, or `Claude Code-credentials-<h>` otherwise, where
  `<h>` is the first 8 hex characters of `sha256(normalised absolute path)`.
- `$CLAUDE_CONFIG_DIR/.credentials.json`, field `claudeAiOauth.accessToken`.

**A participant MUST NOT fall back from the hashed service name to the bare
one.** The config directory is how a second account is configured, so a missing
hashed entry means that account has no credential — not that the default
account's will do. Falling back reads one account's usage into another
account's cache, and nothing downstream can detect it. Show no quota instead.

A participant MUST treat a credential with `expiresAt` in the past, or a
present-but-non-numeric `expiresAt`, as absent. An *absent* `expiresAt` is
accepted: some credential shapes omit it, and refusing those would break
authentication that works. No participant refreshes the token; that is
Claude Code's job.

`ANTHROPIC_BASE_URL` is deliberately ignored — the OAuth usage endpoint is tied
to anthropic.com and does not exist on a proxy or a self-hosted gateway.

TLS minimum version 1.2. No certificate pinning: Anthropic rotates its leaf and
publishes no pin set, so a hardcoded hash becomes an outage. Response body is
capped at 1 MB and the request has both a per-activity and an absolute 15 s
deadline, the latter for slow-loris tolerance.

Users on Bedrock or Vertex have no Claude OAuth token; a participant finding no
credential does nothing and reports no usage. That is not an error state.

---

## 7. Versioning

`schemaVersion` is 1. A participant reading a file whose `schemaVersion` exceeds
what it implements MUST **stand down**: serve nothing, fetch nothing, write
nothing. Not "treat it as absent" — absent means *go and fetch*, and a
participant that fetched would have nowhere to put the result except on top of
a file it does not understand, downgrading it for everyone else.

Standing down means an old tool shows no quota while a newer one is present.
That is the correct trade: the newer participant is keeping the reading current,
so the numbers exist, and the old tool simply is not the one to show them. If
the newer tool is later removed, the file is stale and nothing will replace it —
delete it and the next participant starts clean. Implementations SHOULD warn
when they stand down, so that state is diagnosable rather than mysterious.

Additive changes — a new bucket key, a new optional top-level field — do not bump
the version. Anything that changes the meaning of an existing field does.

---

## 8. What this protocol does not cover

- **Plan name resolution.** Derived from the profile API and the credential's
  rate-limit tier; cached separately by the reference implementation. It is a
  label, not a measurement.
- **Prepaid credit grant.** A separate endpoint on a different cadence.
- **Projection.** Where a window lands by its reset is a modelling choice, not a
  reading, and participants legitimately disagree. Only measurements go in these
  files.
