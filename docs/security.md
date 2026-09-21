---
title: Security and troubleshooting
order: 30
summary: Where the token comes from, what is written to disk and with which permissions, why the certificate is not pinned, and what each warning means.
---

> [!TLDR]
> The token is read from the Keychain (or a `0600` credentials file owned by you); every file the plugin writes is `0600` and refused if broader; dashboard strings are HTML-escaped; TLS 1.2 is the floor and the leaf certificate is not pinned.

## Security model {#model}

```oku-table
{"headers":["Surface","Rule","Why"],"rows":[["Credential source","Keychain first; `~/.claude/.credentials.json` as the fallback, refused unless `0600` and owned by the current user","A token planted by another local user is never used"],["Cache files","`data.js`, `credit-grant.js`, `.profile-cache.json`, `dashboard.html` under `~/.claude/plugins/claude-quota/`, mode `0600`; the renderer refuses broader modes","A second local user cannot feed the dashboard"],["Dashboard output","Every externally sourced string (today, the plan name) is HTML-escaped","A tampered API response cannot run script in the page"],["HTTPS","Node's system trust store, TLS 1.2 minimum, no certificate pin","Anthropic rotates the leaf without a published pin set; a hardcoded pin would become an outage. Someone who can install a trusted CA on the host can intercept the call; the `0600` files and the escaping are the defence behind that line"],["Stderr","One warning line for HTTP 401/403, rejected cache files and rejected credential files; rate limits and expiry stay silent","`CLAUDE_QUOTA_SILENT=1` disables all warnings"]]}
```

## Troubleshooting {#troubleshooting}

```oku-table
{"headers":["Symptom","Meaning","What to do"],"rows":[["No quota line","API-key login, a free plan, or a custom `ANTHROPIC_BASE_URL`; usage is fetched only for direct Claude.ai OAuth subscribers","Nothing — the model and context line still renders"],["`usage:⚠`","The API is unreachable (network error, timeout); cached data is shown for 15 seconds, then the warning","Wait; it clears on the next successful fetch"],["`⟳` stays on","The usage API rate-limited the plugin; last-known data is shown and the retry backs off from 60 seconds to 10 minutes","Wait; the glyph clears on the next successful fetch"],["`[claude-quota] cache file rejected … reason=permissive-mode`","A cache file written before the permission hardening; the plugin refuses it and re-fetches","Nothing — the next successful write is `0600`; `CLAUDE_QUOTA_SILENT=1` hides the line"]]}
```
