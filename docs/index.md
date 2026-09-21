---
title: claude-quota
eyebrow: Claude Code statusline plugin · TypeScript
subtitle: Every Claude Code quota in the statusline — session, weekly, per-model and extra usage — with a pace arrow that says whether you will run out before the window resets.
order: 1
summary: What the statusline shows, segment by segment, and what the colours mean.
---

> [!TLDR]
> Claude Code tells you about a quota when you hit it. This plugin reads the same usage API the `/usage` page reads and keeps every bucket in view while you work: used share, elapsed share, where you will land at reset at this rate, and what extra usage has cost.
>
> - `npm install -g @mmdemirbas/claude-quota`, one line in `settings.json`
> - Three lines on a normal terminal, one on a short one, never wraps
> - An HTML dashboard rewritten on every render

## What you see {#see}

![Three-line statusline: model and context on the first line, the 5-hour and Sonnet quotas on the second, the 7-day quota and extra usage on the third](statusline-dark.png)

*A Max 5x subscriber mid-session, over pace on the 5-hour window (`↗145%`), on pace for Sonnet (`→ 90%`).*

![The statusline with every segment labelled](anatomy.png)

```oku-table
{"headers":["Segment","Meaning"],"rows":[["`sonnet high`","Model family and effort level"],["`ctx:██░░░░░░░░  23%`","Context window: a 10-cell bar and the percentage"],["`dashboard`","An OSC 8 hyperlink to the HTML dashboard; plain text on terminals without link support"],["`lakelab git:(main*)`","Project directory and branch; `*` means a dirty working tree"],["`max 5x`","Plan name and multiplier"],["`5h:` `7d:` `snt:` `ops:`","The 5-hour session window, the 7-day all-models window, the 7-day Sonnet and Opus windows"],["`█████░░░░░  31%`","Used share of the window"],["`↗145%` `→ 90%` `↘ 74%`","Pace: the projected share at the end of the window. Over 100 % means the quota runs out before it resets"],["`◔3h56m`","Time until reset; the glyph is how much of the window has elapsed, `○◔◑◕●` = 0 → 100 %"],["`⟳18:00`","Local time of the last successful fetch"],["`●$:` / `○$:`","Extra usage on or off"],["`  $0 ↘  $0 /$5`","Extra usage spent · pace · projected · monthly limit"]]}
```

## Colour carries the warning {#colour}

The numbers stay small because the colour says whether to worry.

```oku-table
{"headers":["Element","Green / blue","Yellow / magenta","Red"],"rows":[["Context bar","under 70 %","70–85 %","from 85 %"],["Quota bar, filled cells","under 75 %","75–90 %","from 90 %"],["Quota bar, empty cells","dim along the projected path","gray: quota that will go unused (projection under 100 %)","the stretch where the quota is already gone (projection ≥ 100 %)"],["Pace arrow","`↘` under pace","dim `→` on pace","`↗` over pace (yellow, then red)"],["Projection","dim to 79 %","80–100 %","beyond 100 %"],["Money","$0","above $0","from 80 % of the limit"]]}
```

When over pace, the filled cells up to the pace line are dim and the cells past it are bright, so the overshoot is visible in the bar itself.

## Where to go next {#next}

```oku-compare-grid
{"cards":[{"t":"Install","b":"npm or from source; the settings.json line; requirements.","href":"install.html"},{"t":"How it works","b":"Keychain token, the usage API, the cache, the dashboard, the adaptive layout.","href":"how-it-works.html"},{"t":"Security and troubleshooting","b":"What is read, what is written, what a warning means.","href":"security.html"},{"t":"Usage cache protocol","b":"The on-disk format other tools can share.","href":"usage-cache-protocol.html"}]}
```
