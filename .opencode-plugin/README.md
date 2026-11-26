# fast-jev-compaction OpenCode Plugin

A plugin that replaces OpenCode's built-in compaction with Jev-guided verbatim pruning.

## Installation

Add to your `opencode.json`:

```json
{
  "plugins": [
    { "package": "/path/to/fast-jev-compaction/.opencode-plugin" }
  ]
}
```

## Configuration

Set in `opencode.json`:

```json
{
  "plugins": [
    {
      "package": "/path/to/fast-jev-compaction/.opencode-plugin",
      "config": {
        "apiKey": "your-typesafe-api-key",
        "keepThreshold": 0.5,
        "preserveRecentMessages": 6,
        "truncateHeadChars": 300
      }
    }
  ]
}
```

Or set `TYPESAFE_API_KEY` environment variable.

## How It Works

1. Intercepts the `compaction` hook
2. Runs Jev to score tool calls/results
3. If Jev can reduce content meaningfully, sets `event.result` to skip the model call
4. Writes decisions to `.codex/fast-jev-compaction/jev-decisions.jsonl` for reference

## Message Format

OpenCode uses a different message structure than Codex:
- Messages have `type`, `role`, and `content` fields
- Tool use messages have additional `tool_calls` array
- Tool results are inline in assistant messages

This plugin handles both formats.