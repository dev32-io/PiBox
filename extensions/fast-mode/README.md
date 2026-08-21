# ChatGPT Fast mode

PiBox adds `/fast`, an in-place session settings menu for OpenAI ChatGPT Fast mode.

- **Main session:** Off or On
- **Subagents:** Off, Low only, Up to Medium, Up to High, or All tiers

Changes made through `/fast` are stored only in the current Pi session. They survive `/reload`, tree navigation, and session resume, and override the global defaults without modifying settings files. Workflow agents use the same subagent tier ceiling.

## Global defaults

Fast mode remains off unless explicitly configured. To opt in for new sessions, add either or both fields to the global `~/.pi/agent/settings.json`:

```json
{
  "fastMode": {
    "main": false,
    "subagents": "medium"
  }
}
```

`main` accepts `true` or `false`. `subagents` accepts `"off"`, `"low"`, `"medium"`, `"high"`, or `"max"`. Missing or invalid fields fall back to off. Only global settings are read; project `.pi/settings.json` cannot enable Fast mode. A valid session-scoped `/fast` choice takes precedence over the global defaults.

Fast mode is requested only for currently supported first-party `openai-codex` models. Unsupported models, local routes, other providers, and provider fallbacks continue normally without a `service_tier` field. The footer displays the effective request policy after Effort, for example `Fast req: MAIN+SUB≤MED`. Active inline subagents, background subagent rows, and managed workflow rows append `· Fast` only when that resolved process is requesting Fast mode. Settled foreground rows retain the resolved route and Fast marker for inspection.

Fast mode consumes ChatGPT credits at a higher rate. PiBox indicators report requested Fast mode, not the provider-confirmed response tier; OpenAI may still serve an individual request at its default tier. Confirm the served tier in OpenAI usage reporting grouped by service tier.
