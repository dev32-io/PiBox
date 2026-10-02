# Model tier list profiles

Provides session-scoped route profiles for PiBox managed-agent capability tiers. The planner continues to choose `low`, `medium`, `high`, or `max`; the selected profile determines the ordered `provider/model#effort` list used for that tier.

PiBox ships one default profile, `codex`:

| Capability tier | Codex route |
|---|---|
| Low | `openai-codex/gpt-6-luna#xhigh` |
| Medium | `openai-codex/gpt-6.1-sol#high` |
| High | `openai-codex/gpt-6-astra#low` |
| Max | `openai-codex/gpt-6-astra#medium` |
| Local | `local-llm/qwen-3.8-27b#xhigh` |

Switch the current session with `/tier-profile`, or directly with `/tier-profile <name>`. The selection is stored in the Pi session and affects future managed-agent launches; already-running agents are unchanged.

## Global defaults

Edit `modelTierListProfiles` in **`~/.pi/agent/settings.json`**, the official global Pi settings file (`PI_CODING_AGENT_DIR` changes its directory). The tier extension seeds the shipped `codex` profile only when the file or that key is absent, preserving unrelated settings. Otherwise the existing value is authoritative: it is never merged with shipped defaults, never rewritten, and user-defined profiles stay intact. Malformed or invalid settings are reported and block startup instead of being repaired. Read-only configuration loaders use the shipped default when the file or key is absent and do not create the file.

Initialization shares Pi's `settings.json.lock` and atomically replaces the settings file. A busy lock produces a bounded error naming the lock; PiBox does not forcibly remove it. Pi 0.84.3 has an upstream first-file-creation race: a simultaneous native settings save that began while the file was absent can replace newly seeded defaults after acquiring the lock. Avoid simultaneous first-run saves; if the tier section is lost, built-in routing remains available and `/reload` restores it. Existing-file concurrent native writes are covered by regression tests.

The settings contain `defaultProfile` and the complete named `profiles` with ordered tier route arrays. Because an existing value is authoritative, every configured profile must supply its own non-empty `max`, `high`, `medium`, `low`, and provider-isolated `local` arrays. For example:

```json
{
  "modelTierListProfiles": {
    "defaultProfile": "codex",
    "profiles": {
      "codex": {
        "low": ["openai-codex/gpt-6-luna#xhigh"],
        "medium": ["openai-codex/gpt-6.1-sol#high"],
        "high": ["openai-codex/gpt-6-astra#low"],
        "max": ["openai-codex/gpt-6-astra#medium"],
        "local": ["local-llm/qwen-3.8-27b#xhigh"]
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
    codex:
      medium: [openai-codex/gpt-6.1-sol#high]
```

This replaces only `codex.medium`, including its entire fallback list. Omitted profiles and tiers retain their global values. Repository-only profile names are additive; their resulting definitions must be complete. Resolution is shipped defaults (only when global settings has no tier configuration) → global settings → repository overrides. An explicit session profile selection wins; otherwise an explicit repository `defaultProfile` overrides the global default. Project `.pi/settings.json` is not a tier-policy source.

Every resulting profile must provide a non-empty list for `max`, `high`, `medium`, `low`, and provider-isolated `local`. Profile selection changes managed-subagent routing only: it does not add capability tiers, alter provider configuration or live services, or introduce runtime retries. The selector, standalone subagents, and workflow configuration use the same global tier source.

## Legacy configuration

Global `~/.pi/agent/harness/config.yaml` no longer supplies tier definitions, but remains supported for unrelated harness/agent policy. Move its `modelTierListProfiles` into global `settings.json` if you want to retain those routes; no automatic migration copies legacy or repository routes into global settings. The former top-level `modelTiers` field remains supported in repository policy and is normalized into the configured default profile.
