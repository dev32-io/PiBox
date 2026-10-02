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

Fast mode can be requested for every model ID from the first-party `openai-codex` provider using the `openai-codex-responses` API, including Spark, mini, and future models; there is no model allowlist. The main-session preference and subagent tier ceiling still control whether Fast is requested. Each fallback route recomputes effective Fast from the configured tier preference: local routes, other providers, and other APIs omit `service_tier`; any Codex fallback on that API can request Fast when the tier preference allows it. The footer displays the effective request policy after the tier profile, for example `Fast: Main+Sub≤Med`. Active inline subagents, background subagent rows, and managed workflow rows append `· Fast` only when that resolved process is requesting Fast mode. Settled foreground rows retain the resolved route and Fast marker for inspection.

Fast mode consumes ChatGPT credits at a higher rate. PiBox indicators report requested Fast mode, not the provider-confirmed response tier; OpenAI may still serve an individual request at its default tier. Confirm the served tier in OpenAI usage reporting grouped by service tier.
