# Harness Model Tier Guidance

PiBox separates the main orchestrator from managed task capability tiers. Choose them for different jobs: the orchestrator carries product judgment and workflow authority, while tier routes execute bounded implementation, review, repair, and E2E assignments.

## Recommended Tier Profiles

Profiles choose models and effort; capability tiers describe the assignment. `performance` remains the default, using Sol for medium and above. `token-conservative` routes common medium work to Luna Max to preserve subscription capacity. The opt-in `nuke` profile spends more on model quality: ordinary medium work uses Astra medium, while routine low-tier work stays on Luna. Selecting Nuke does not justify increasing task tiers.

| Capability tier | Token-conservative | Performance (default) | Nuke (opt-in) |
|---|---|---|---|
| Low | Luna high | Luna high | Luna high |
| Medium | Luna max | Sol medium | Astra medium |
| High | Sol high | Sol high | Astra high |
| Max | Sol max | Sol max | Astra max |
| Local | Local routes only | Local routes only | Local routes only |

Switch the current Pi session with `/tier-profile nuke`, or use `/tier-profile` to choose. Existing running agents and planned capability tiers do not change.

User defaults live under `modelTierListProfiles` in **`~/.pi/agent/settings.json`** (or the directory selected by `PI_CODING_AGENT_DIR`). The tier extension populates missing defaults at session startup without replacing existing customizations. Edit that JSON object to customize `defaultProfile` and named `profiles` globally. Trusted repositories may override individual same-name profile/tier lists in `.pi/harness.yaml`; an override replaces the whole route array, while omitted lists inherit global settings. New scaffolds omit tier overrides. Explicit session selection wins over the repository default, which wins over the global default. See [configuration details and legacy migration](../extensions/model-tier-list-profiles/README.md).

The following optional repository override example shows primary routes only; copying it replaces the corresponding fallback arrays. Built-in Nuke medium/high/max lists fall back to matching-effort Sol and then the existing tier's DeepSeek route.

```yaml
modelTierListProfiles:
  defaultProfile: performance
  profiles:
    nuke:
      max: [openai-codex/gpt-6-astra#max]
      high: [openai-codex/gpt-6-astra#high]
      medium: [openai-codex/gpt-6-astra#medium]
      low: [openai-codex/gpt-5.6-luna#high]
      local: [local-llm/meta/muse-glimmer#high]
    performance:
      max: [openai-codex/gpt-5.6-sol#max]
      high: [openai-codex/gpt-5.6-sol#high]
      medium: [openai-codex/gpt-5.6-sol#medium]
      low: [openai-codex/gpt-5.6-luna#high]
      local: [local-llm/meta/muse-glimmer#high]
    token-conservative:
      max: [openai-codex/gpt-5.6-sol#max]
      high: [openai-codex/gpt-5.6-sol#high]
      medium: [openai-codex/gpt-5.6-luna#max]
      low: [openai-codex/gpt-5.6-luna#high]
      local: [local-llm/meta/muse-glimmer#high]
```

Each tier list contains availability fallbacks, not quality escalation after weak output. Additional complete profiles may be declared under `profiles`; every resulting profile supplies max, high, medium, low, and provider-isolated local lists. Partial overrides of existing profiles inherit their omitted lists.

Standalone `subagent_spawn` also uses these profiles. An effort-only override changes the primary route's effort without changing fallback efforts. Explicit model requests are strict unless `allowFallback: true` is supplied; standalone fallback happens before launch, not after a runtime provider failure. See [standalone subagents](subagents.md) for exact routing, title, continuation and report-reading semantics.

### Tier intent

Choose the smallest sufficient tier for the assignment, not a fixed tier for the agent's role. Standalone agent-definition tiers are overridable defaults: callers may downshift or upshift. A definition with a pinned `model` retains explicit-model precedence; `tier` alone does not replace that model. Workflow task creation separately defaults to medium when no task tier is supplied; this profile change does not alter that contract.

- **Low:** bounded repository scans, extraction, focused research, routine verification, and mechanical low-risk changes.
- **Medium:** ordinary coherent implementation, review, and investigation. This is the usual working tier, including Astra medium under Nuke.
- **High:** difficult, tightly coupled reasoning where medium is insufficient and safe decomposition would lose necessary context. High is the normal ceiling for hard work.
- **Max:** a **very rare exception**, only for a specific reasoning bottleneck where High is demonstrably insufficient, or there is a concrete task-specific reason to expect it will be, and better context, tools, or safe decomposition will not solve it. Explain **why High is insufficient** and **what Max should improve**. A failed High attempt is not required when the evidence already supports that choice. When uncertain about Max, choose High.

Repository size, importance, security labels, urgency, vague uncertainty, a single failed attempt, and selection of Nuke are not sufficient reasons for Max. Routine research, implementation, and review should not use Max. Do not increase tiers to compensate for vague assignments or tooling failures. This is selection guidance, not a new hard cap or automatic escalation mechanism; existing workflow `tierJustification` requirements still apply.

Ollama Pro allows three concurrent cloud models, while usage is weighted by model compute. DeepSeek V4 Pro is an extra-heavy model, so using Flash for routine medium agents preserves substantially more workflow throughput.

## Orchestrator Guidance

GLM-5.2 has a useful split profile. It is strong at sustained product discussion, architecture exploration, security analysis, uncovering hidden requirements, and explaining trade-offs. It has shown weaker discipline around strict workflow schemas and managed execution ownership.

Use phase-sensitive orchestration:

| Phase | Recommended main model |
|---|---|
| Product discussion | `ollama-cloud/glm-5.2#high` |
| Story shaping and design | `ollama-cloud/glm-5.2#high` |
| Delivery planning | GLM-5.2 high after evaluation; Sol-high when maximum procedural reliability is needed |
| Managed workflow execution | `openai-codex/gpt-5.6-sol#high` |
| Failure and recovery management | `openai-codex/gpt-5.6-sol#high` |
| Outcome briefing | GLM-5.2 high or Sol-high |

An alternative is to retain GLM-5.2 as the main product and technical orchestrator while routing bounded managed work through the tier table above. Promote GLM to unattended execution only after it demonstrates that it can:

- preserve harness ownership of source edits, Git, worktrees, fixers, and reviewers;
- resolve only the matching authoritative attention state;
- avoid replacement reviewer or E2E launches;
- pause after persistent managed-action failure;
- avoid unrelated artifact changes.

## Selection Principles

1. Set coherent fresh-agent boundaries before increasing model strength. Medium is the default when one agent can retain the assignment's relevant invariants, implementation, and proof without crossing into an unrelated problem domain.
2. Use model strength for irreducible complexity, not to compensate for vague tickets or artificial task splitting.
3. Prefer GLM-5.2 where product, architecture, and security exploration matter most.
4. Prefer Sol for unattended workflow control and recovery until alternatives pass PiBox behavioral evaluations.
5. Keep `performance` for the normal Sol-based balance, use `token-conservative` when subscription capacity dominates, and explicitly select `nuke` when higher model quality warrants the spend. Astra medium is a starting policy, not a proven optimum for every PiBox assignment. Select a new-session default with `modelTierListProfiles.defaultProfile` in global `settings.json`, unless the repository explicitly overrides that default.
6. Treat vendor benchmarks as directional. PiBox workflow evaluations and observed tool discipline are authoritative for routing decisions.

## Research basis

As of September 6, 2026, [Artificial Analysis's Astra evaluation](https://artificialanalysis.ai/articles/benchmarking-gpt-6-astra) reports strong coding-agent token efficiency: Astra max used roughly one-third of Sol max's tokens at comparable API cost per coding task, with a slightly higher score. Its general-intelligence evaluation showed a different cost tradeoff. These are harness-dependent results, not a guarantee of PiBox task latency or Codex subscription usage. [OpenAI's model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra) confirms Astra's low, medium, high, xhigh, and max effort levels. Keep model routing decisions grounded in observed task success, retries, latency, and quota consumption.

## External References

- [DeepSeek V4 technical report](https://arxiv.org/html/2606.19348v1)
- [Ollama DeepSeek V4 Flash](https://ollama.com/library/deepseek-v4-flash)
- [Ollama DeepSeek V4 Pro](https://ollama.com/library/deepseek-v4-pro)
- [Ollama pricing and cloud limits](https://ollama.com/pricing)
- [GLM-5.2 documentation](https://docs.z.ai/guides/llm/glm-5.2)
- [Z.ai GLM-5.2 announcement](https://z.ai/blog/glm-5.2)
- [NIST/CAISI GLM-5.2 assessment](https://www.nist.gov/system/files/documents/2026/07/17/CAISI%20-%20Assessment%20of%20Z.ai%27s%20GLM-5.2.pdf)
