# Harness Model Tier Guidance

PiBox separates the main orchestrator from managed task capability tiers. Choose them for different jobs: the orchestrator carries product judgment and workflow authority, while tier routes execute bounded implementation, review, and evaluation assignments.

## Recommended Tier Routes

```yaml
modelTiers:
  max:
    - openai-codex/gpt-5.6-sol#high
    - ollama-cloud/deepseek-v4-pro#max

  high:
    - openai-codex/gpt-5.6-sol#medium
    - ollama-cloud/deepseek-v4-pro#high
    - openai-codex/gpt-5.6-luna#max

  medium:
    - openai-codex/gpt-5.6-luna#max
    - ollama-cloud/deepseek-v4-flash#max

  low:
    - openai-codex/gpt-5.6-luna#low
    - ollama-cloud/deepseek-v4-flash#low
```

Routes are availability fallbacks, not quality escalation after a model produces weak work. Put the preferred model first.

### Tier intent

- **Max:** exceptional architecture, security/privacy, irreversible decisions, and unusually high-blast-radius work.
- **High:** difficult bounded implementation and review where medium is insufficient and further decomposition would damage the required seam.
- **Medium:** default for aggressively decomposed implementation and review tasks. DeepSeek V4 Flash at maximum reasoning is appropriate here; use Pro for harder agentic work rather than every routine task.
- **Low:** genuinely mechanical, low-risk changes only.

Ollama Pro allows three concurrent cloud models, while usage is weighted by model compute. DeepSeek V4 Pro is an extra-heavy model, so using Flash for routine medium workers preserves substantially more workflow throughput.

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
- use only the matching checkpoint action;
- avoid replacement reviewer or E2E launches;
- pause after persistent managed-action failure;
- avoid unrelated artifact changes.

## Selection Principles

1. Decompose work before increasing model strength. Medium is the default because tasks should be small enough for medium workers.
2. Use model strength for irreducible complexity, not to compensate for vague tickets.
3. Prefer GLM-5.2 where product, architecture, and security exploration matter most.
4. Prefer Sol for unattended workflow control and recovery until alternatives pass PiBox behavioral evaluations.
5. Prefer DeepSeek V4 Flash-Max for routine medium work and DeepSeek V4 Pro for high/max Ollama fallback.
6. Treat vendor benchmarks as directional. PiBox workflow evaluations and observed tool discipline are authoritative for routing decisions.

## External References

- [DeepSeek V4 technical report](https://arxiv.org/html/2606.19348v1)
- [Ollama DeepSeek V4 Flash](https://ollama.com/library/deepseek-v4-flash)
- [Ollama DeepSeek V4 Pro](https://ollama.com/library/deepseek-v4-pro)
- [Ollama pricing and cloud limits](https://ollama.com/pricing)
- [GLM-5.2 documentation](https://docs.z.ai/guides/llm/glm-5.2)
- [Z.ai GLM-5.2 announcement](https://z.ai/blog/glm-5.2)
- [NIST/CAISI GLM-5.2 assessment](https://www.nist.gov/system/files/documents/2026/07/17/CAISI%20-%20Assessment%20of%20Z.ai%27s%20GLM-5.2.pdf)
