# Model tier list profiles

Provides session-scoped route profiles for PiBox managed-agent capability tiers. The planner continues to choose `low`, `medium`, `high`, or `max`; the selected profile determines the ordered `provider/model#effort` list used for that tier.

Built-in profiles:

- `performance` (default): Sol routes for medium and above.
- `token-conservative`: Luna Max for the common medium tier while retaining Sol for high/max work.

Switch the current session with `/tier-profile`, or directly with `/tier-profile <name>`. The selection is stored in the Pi session and affects future managed-agent launches; already-running agents are unchanged.

An optional global Pi setting chooses the default for new sessions:

```json
{
  "modelTierListProfiles": {
    "defaultProfile": "token-conservative"
  }
}
```

Repositories can define or replace any number of profiles in `.pi/harness.yaml`:

```yaml
schemaVersion: 2
modelTierListProfiles:
  defaultProfile: performance
  profiles:
    performance:
      max: [openai-codex/gpt-5.6-sol#max]
      high: [openai-codex/gpt-5.6-sol#high]
      medium: [openai-codex/gpt-5.6-sol#medium]
      low: [openai-codex/gpt-5.6-luna#high]
      local: [local-llm/meta/muse-glimmer#high]
```

Every profile must provide a non-empty list for `max`, `high`, `medium`, `low`, and provider-isolated `local`. The former top-level `modelTiers` field remains readable and is normalized into the configured default profile.
