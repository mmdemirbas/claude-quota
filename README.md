# claude-quota

Compact, quota-focused statusline plugin for Claude Code. Shows **all** usage buckets at a glance — no more visiting the usage page.

## What you see

```
[Sonnet 4.6 | Max] ████░░░░ 79% │ lakelab git:(main*) │ 5h:36%↻1h55m 7d:18% snt:56% $0.00/$5
```

| Segment | Meaning |
|---------|---------|
| `[Sonnet 4.6 \| Max]` | Current model and plan |
| `████░░░░ 79%` | Context window usage (green/yellow/red) |
| `lakelab git:(main*)` | Project directory and git branch |
| `5h:36%↻1h55m` | 5-hour session quota + reset countdown |
| `7d:18%` | 7-day all-models quota |
| `snt:56%` | 7-day Sonnet-only quota |
| `$0.00/$5` | Extra usage spend / monthly limit |

### Color coding

- **Context**: green < 70% → yellow 70-85% → red ≥ 85%
- **Quotas**: blue < 75% → magenta 75-90% → red ≥ 90%
- **Money**: green = $0 → yellow > $0 → red ≥ 80% of limit

## Install

```bash
# Clone to your plugins directory
cd ~/.claude/plugins
git clone https://github.com/mdemirbas/claude-quota.git

# Build
cd claude-quota
npm install
npm run build

# Restart Claude Code
```

## Replaces

If you were using `claude-hud`, disable it first:
```bash
# In Claude Code
/plugins
# → disable claude-hud
```

## How it works

1. Claude Code pipes context data (model, tokens, cwd) via stdin
2. Plugin reads OAuth credentials from macOS Keychain (same as claude-hud)
3. Calls `api.anthropic.com/api/oauth/usage` (cached 5 min)
4. Renders a single-line status bar to stdout

## Customization

Edit `src/render.ts` to change the format. It's straightforward, well-commented code.
