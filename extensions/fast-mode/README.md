# ChatGPT Fast mode

PiBox adds `/fast`, an in-place session settings menu for OpenAI ChatGPT Fast mode.

- **Main session:** Off or On
- **Subagents:** Off, Low only, Up to Medium, Up to High, or All tiers

The policy is stored only in the current Pi session. It survives `/reload`, tree navigation, and session resume, but does not modify global or project settings. Workflow agents use the same subagent tier ceiling.

Fast mode is requested only for currently supported first-party `openai-codex` models. Unsupported models, local routes, other providers, and provider fallbacks continue normally without a `service_tier` field. The footer displays the effective request policy after Thinking, for example `Fast req: MAIN+SUB≤MED`. Active inline subagents, background subagent rows, and managed workflow rows append `· Fast` only when that resolved process is requesting Fast mode. Settled foreground rows retain the resolved route and Fast marker for inspection.

Fast mode consumes ChatGPT credits at a higher rate. PiBox indicators report requested Fast mode, not the provider-confirmed response tier; OpenAI may still serve an individual request at its default tier. Confirm the served tier in OpenAI usage reporting grouped by service tier.
