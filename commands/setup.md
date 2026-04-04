# Setup claude-quota

This plugin shows a compact statusline with full usage breakdown:
- **Context**: current context window usage with colored bar
- **5h session**: current session utilization + reset countdown
- **7d all-models**: weekly all-models quota
- **7d sonnet**: weekly sonnet-specific quota
- **7d opus**: weekly opus-specific quota (if applicable)
- **Extra usage**: spend vs monthly limit

## Output format

```
[Sonnet 4.6 | Max] ████░░░░ 79% │ lakelab git:(main*) │ 5h:36%↻1h55m 7d:18% snt:56% $0.00/$5
```

## Prerequisites

- macOS with Claude Code credentials in Keychain (standard setup)
- Node.js >= 18

## No configuration needed

The plugin reads your OAuth credentials automatically from the macOS Keychain
(same method as claude-hud). Usage data is cached for 5 minutes to respect API rate limits.
