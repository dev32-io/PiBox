# Model tier list profiles

Provides session-scoped route profiles for PiBox managed-agent capability tiers. The planner continues to choose `low`, `medium`, `high`, or `max`; the selected profile determines the ordered `provider/model#effort` list used for that tier.

Built-in profiles, in selector order:

- `nuke` (opt-in): Astra at medium/high/max, then same-effort Sol, then the existing DeepSeek fallback. Low and local routing match the existing scope policy.
- `performance` (default): Sol routes for medium and above.
- `token-conservative`: Luna Max for the common medium tier while retaining Sol for high/max work.

Switch the current session with `/tier-profile`, or directly with `/tier-profile <name>`. The selection is stored in the Pi session and affects future managed-agent launches; already-running agents are unchanged.

## Global defaults

Edit `modelTierListProfiles` in **`~/.pi/agent/settings.json`**, the official global Pi settings file (`PI_CODING_AGENT_DIR` changes its directory). The tier extension populates missing defaults when it loads, including startup and `/reload`, preserving existing customizations and unrelated settings. Initialization is idempotent; malformed settings are reported rather than overwritten. Read-only configuration loaders use shipped defaults when the file is absent and do not create it.

Initialization shares Pi's `settings.json.lock` and atomically replaces the settings file. A busy lock produces a bounded error naming the lock; PiBox does not forcibly remove it. Pi 0.84.3 has an upstream first-file-creation race: a simultaneous native settings save that began while the file was absent can replace newly seeded defaults after acquiring the lock. Avoid simultaneous first-run saves; if the tier section is lost, built-in routing remains available and `/reload` restores missing defaults. Existing-file concurrent native writes are covered by regression tests.

The settings contain `defaultProfile` and the complete named `profiles` with ordered tier route arrays. For example, this partial configuration changes the new-session default and one inherited route list:

```json
{
  "modelTierListProfiles": {
    "defaultProfile": "token-conservative",
    "profiles": {
      "token-conservative": {
        "medium": ["openai-codex/gpt-5.6-luna#max", "ollama-cloud/deepseek-v4-flash#max"]
      }
    }
  }
}
```

## Repository overrides

New repository scaffolds omit tier profiles so they inherit global settings. Add only intentional overrides to trusted repositories' `.pi/harness.yaml`:

```yaml
schemaVersion: 2
modelTierListProfiles:
  profiles:
    performance:
      medium: [openai-codex/gpt-5.6-sol#high]
```

This replaces only `performance.medium`, including its entire fallback list. Omitted profiles and tiers retain their global values. Repository-only profile names are additive; their resulting definitions must be complete. Resolution is shipped defaults → global settings → repository overrides. An explicit session profile selection wins; otherwise an explicit repository `defaultProfile` overrides the global default. Project `.pi/settings.json` is not a tier-policy source.

Every resulting profile must provide a non-empty list for `max`, `high`, `medium`, `low`, and provider-isolated `local`. Profile selection changes managed-subagent routing only: it does not add capability tiers, alter provider configuration or live services, or introduce runtime retries. The selector, standalone subagents, and workflow configuration use the same global tier source.

## Legacy configuration

Global `~/.pi/agent/harness/config.yaml` no longer supplies tier definitions, but remains supported for unrelated harness/agent policy. Move its `modelTierListProfiles` into global `settings.json` if you want to retain those routes; no automatic migration copies legacy or repository routes into global settings. The former top-level `modelTiers` field remains supported in repository policy and is normalized into the configured default profile.
