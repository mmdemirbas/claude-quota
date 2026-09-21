---
title: Install
order: 10
summary: npm or from source, the settings.json line, requirements, and the claude-hud note.
---

> [!TLDR]
> `npm install -g @mmdemirbas/claude-quota`, then set `statusLine.command` to `claude-quota` in `~/.claude/settings.json`. Needs a Pro or Max login and Node 18+.

## From npm {#npm}

```oku-step-flow
{"steps":[{"t":"Install the package","b":"`npm install -g @mmdemirbas/claude-quota` puts a `claude-quota` binary on the PATH."},{"t":"Point the statusline at it","b":"In `~/.claude/settings.json`: `{ \"statusLine\": { \"type\": \"command\", \"command\": \"claude-quota\" } }`."},{"t":"Open Claude Code","b":"The first render fetches usage and writes the cache; later renders read it and refresh in the background."}]}
```

```json
{
  "statusLine": {
    "type": "command",
    "command": "claude-quota"
  }
}
```

## From source {#source}

```bash
git clone https://github.com/mmdemirbas/claude-quota.git
cd claude-quota
npm install
./ctl deploy link    # builds and links the global claude-quota binary to this checkout
```

After `deploy link`, every `./ctl build` takes effect immediately; the same `settings.json` line applies.

## Requirements {#requirements}

```oku-table
{"headers":["Needs","Why"],"rows":[["Claude Code with a Pro or Max subscription (OAuth login)","The usage API has nothing for API-key users; they get the model and context line only"],["Node.js 18 or newer","The plugin is an ES module"],["macOS Keychain, or `~/.claude/.credentials.json` elsewhere","Where the OAuth token Claude Code itself uses is read from — see the security model"]]}
```

## If you use claude-hud {#claude-hud}

Disable it first so the two do not share the line:

```json
{
  "enabledPlugins": {
    "claude-hud@claude-hud": false
  }
}
```
