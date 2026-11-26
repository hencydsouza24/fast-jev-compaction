# fast-jev-compaction Codex Plugin

A Codex plugin that replaces the built-in compaction summary with Jev decisions.

## ⚠️ Important Limitation

Codex hooks cannot directly replace the compacted transcript like Claude Code plugins can. This plugin uses a **two-phase approach**:

1. **PreCompact phase**: Runs Jev compaction and writes a decisions log + replacement transcript
2. **SessionStart(compact) phase**: Reads the decisions log and injects it as additional context for the next model request

This preserves the verbatim text of user/assistant messages while Jev prunes tool calls/results that are no longer needed.

## Installation

```sh
# Clone the repo and install the plugin
git clone https://github.com/tamaratran/fast-jev-compaction.git
cd fast-jev-compaction
npm install -g
codex plugin add ./fast-jev-compaction
```

Or add to your `requirements.toml`:
```toml
[[plugins]]
name = "fast-jev-compaction"
source = "path"
```

Then enable in config.toml:
```toml
[plugins.fast-jev-compaction]
enabled = true
```

## Configuration

Set in `config.toml` or via plugin options:

| Option | Default | Description |
|--------|---------|-------------|
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key |
| `keepThreshold` | `0.5` | Min probability for keep decision |
| `preserveRecentMessages` | `6` | Recent messages never compacted |
| `compactAtPercent` | `60` | Auto-compact trigger percent |
| `minReductionRatio` | `0.25` | Min reduction to replace history |
| `maxStateTokens` | `25000` | Token budget for state sent to Jev |
| `maxRequestTokens` | `30000` | Token budget per Jev request |
| `truncateHeadChars` | `300` | Chars kept in truncated results |
| `model` | `jev-latest` | Jev model name |

## How It Works

1. **Auto-trigger**: When Codex's context reaches `compactAtPercent`
2. **PreCompact hook**: Runs Jev to score tool calls/results, writes decisions to `.codex/fast-jev-compaction/jev-decisions.jsonl`
3. **Built-in compaction**: Proceeds normally (we can't block it)
4. **SessionStart(compact)**: Reads decisions log, formats as context showing what was dropped
5. **Next model request**: Sees the decisions log explaining what changed

## Development

```sh
# From repo root
npm install
npm run build
npm test

# The plugin is automatically available via --plugin-dir
```

## Architecture Note

Unlike Claude Code's `session.compact` hook that can return modified messages, Codex's hook system:
- PreCompact: returns `{ continue: boolean }` only (can't modify transcript)
- PostCompact: returns `{ continue: boolean }` only (can't modify transcript)  
- SessionStart(source="compact"): can return `additionalContext` that injects into next model prompt

This plugin works within these constraints by using SessionStart's additionalContext capability.

## References

- [Codex Hooks Documentation](https://learn.chatgpt.com/docs/hooks)
- [fast-jev-compaction GitHub](https://github.com/tamaratran/fast-jev-compaction)