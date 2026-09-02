# Harness Model Tier Guidance

PiBox separates the main orchestrator from managed task capability tiers. Choose them for different jobs: the orchestrator carries product judgment and workflow authority, while tier routes execute bounded implementation, review, repair, and E2E assignments.

## Recommended Tier Profiles

The built-in `performance` profile minimizes expected delivery latency with Sol for medium and above. `token-conservative` keeps high/max work on Sol but routes the common medium tier to Luna Max to preserve weekly subscription capacity at the cost of wall time. Switch the current Pi session with `/tier-profile`; planned capability tiers do not change.

```yaml
modelTierListProfiles:
  defaultProfile: performance
  profiles:
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

Each tier list contains availability fallbacks, not quality escalation after weak output. Additional complete profiles may be declared under `profiles`; every profile supplies max, high, medium, low, and provider-isolated local lists.

### Tier intent

- **Max:** exceptional architecture, security/privacy, irreversible decisions, and unusually high-blast-radius work.
- **High:** difficult bounded implementation and review where medium is insufficient and further decomposition would damage the required seam.
- **Medium:** default for coherent, bounded implementation and review assignments. DeepSeek V4 Flash at maximum reasoning is appropriate here; use Pro for harder agentic work rather than every routine task.
- **Low:** genuinely mechanical, low-risk changes only.

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
5. Use `performance` when start-to-green dominates and `token-conservative` when weekly subscription capacity dominates; select a new-session default with the optional global Pi setting `modelTierListProfiles.defaultProfile`.
6. Treat vendor benchmarks as directional. PiBox workflow evaluations and observed tool discipline are authoritative for routing decisions.

## External References

- [DeepSeek V4 technical report](https://arxiv.org/html/2606.19348v1)
- [Ollama DeepSeek V4 Flash](https://ollama.com/library/deepseek-v4-flash)
- [Ollama DeepSeek V4 Pro](https://ollama.com/library/deepseek-v4-pro)
- [Ollama pricing and cloud limits](https://ollama.com/pricing)
- [GLM-5.2 documentation](https://docs.z.ai/guides/llm/glm-5.2)
- [Z.ai GLM-5.2 announcement](https://z.ai/blog/glm-5.2)
- [NIST/CAISI GLM-5.2 assessment](https://www.nist.gov/system/files/documents/2026/07/17/CAISI%20-%20Assessment%20of%20Z.ai%27s%20GLM-5.2.pdf)
