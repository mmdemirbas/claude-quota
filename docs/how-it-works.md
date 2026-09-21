---
title: How it works
order: 20
summary: Token from the Keychain, one call to the usage API, a cache with a background refresh, the dashboard, and how the layout adapts to the terminal.
---

> [!TLDR]
> Claude Code runs the plugin on every statusline refresh; it reads the OAuth token Claude Code uses, calls `api.anthropic.com/api/oauth/usage`, caches the answer for 2 minutes with a background refresh from 90 seconds, and renders one to three lines sized to the terminal.

## One render {#render}

```oku-step-flow
{"steps":[{"t":"Claude Code calls the plugin","b":"As a subprocess on every statusline refresh, with the session's context JSON on stdin: model, effort, context window, cwd."},{"t":"The token is read","b":"From the macOS Keychain, or from `~/.claude/.credentials.json` on other systems — the same credential Claude Code holds."},{"t":"Usage is fetched or served from cache","b":"`GET api.anthropic.com/api/oauth/usage`. The answer is cached for 2 minutes; from 90 seconds a background refresh starts, so a long session never shows stale numbers and never fetches on the hot path."},{"t":"Lines are rendered","b":"One to three lines to stdout, measured in terminal columns, and the HTML dashboard is rewritten beside the cache."}]}
```

## The dashboard {#dashboard}

![The HTML dashboard: one card per window with quota, elapsed time, a pace gauge and the reset time](dashboard.png)

Every render writes `~/.claude/plugins/claude-quota/dashboard.html`, so its figures are the statusline's figures. The page polls its `data.js` every 5 seconds; leave it open in a tab for a live view.

```oku-table
{"headers":["Open it by","Where it works"],"rows":[["Clicking `dashboard` on line 1","Terminals with OSC 8 links: iTerm2, kitty, Ghostty, WezTerm, VS Code's terminal, recent Windows Terminal and GNOME Terminal"],["`open ~/.claude/plugins/claude-quota/dashboard.html`","Everywhere on macOS; paste the `file://` path into a browser elsewhere"]]}
```

The link is the first thing dropped when the terminal is narrow, so the project and branch keep their room.

## The layout adapts {#layout}

The output is measured in terminal columns and never wraps.

```oku-table
{"headers":["Rows available","Layout"],"rows":[["3 or more","The three-line layout"],["2","Line 1 as is; line 2 carries every quota (`5h` `7d` `snt` `ops` `$`)"],["1","`model │ ctx% │ 5h% │ 7d%`, no bars"]]}
```

Per line, content is dropped in this order until it fits:

```oku-step-flow
{"steps":[{"t":"Full","b":"bar + percentage + pace glyph + projection + reset timer"},{"t":"No reset timer","b":"the timer goes first"},{"t":"No pace","b":"then the pace glyph and the projection"},{"t":"Compact","b":"label and percentage only, no bar"}]}
```

Line 1 degrades from `project + branch*` to `project` to nothing. Dimensions come from `process.stderr` (still a TTY when stdout is piped), then `$COLUMNS` / `$LINES`, then defaults.
