# PiBox distill

`/distill` turns an explicit code, release, time, workflow, path, or session range into evidence-backed knowledge proposals for user judgment. Distillation is independent of any memory backend. Local artifacts live under ignored `.pibox/distill/<run-id>/`; source, Git state, guidance, and knowledge stores remain unchanged until the user approves an exact promotion or demotion.

## Flow

1. `distill_prepare` resolves an immutable target/baseline/time/path/workflow/session-entry scope, fingerprints dirty and selected main-session inputs, lists selected knowledge providers with locality, and returns a preview token without writing artifacts.
2. The user reviews the exact resolved commits, counts, source tiers, and estimated partitions.
3. `distill_collect` captures bounded Git evidence, tracked guidance with measured burden, selected workflow artifacts, and a sanitized selected main-session transcript. Activation-private standalone child transcripts are never persisted or recovered. `distill_read sourcePath=…` provides bounded no-checkout reads from the immutable target commit.
4. `knowledge-distiller` subagents analyze coherent partitions from the collected evidence packet.
5. `distill_compare` asks only the user-confirmed knowledge providers for claim-specific comparisons under one aggregate item/character budget. Local Mem0 registers as one optional provider; remote providers are never selected implicitly.
6. `distill_instruction_check` rejects example-bearing or explanatory instruction candidates and reports exact character/token burden.
7. The distill skill discusses proposals with the user. No destination mutation occurs without approval of exact wording, scope, and destination.

## Local artifacts

```text
.pibox/distill/<run-id>/
├── scope.json
├── manifest.json
├── changes.md
├── transcript.md
├── guidance.md
├── workflow.md
├── findings/
├── comparisons/
├── synthesis.md
└── decisions/
```

Collected evidence artifacts are mode-`0600`, bounded, sanitized, and content-hashed in the manifest. Scopes are capped at 2,000 commits and 5,000 changed files and must be narrowed when Git output exceeds the inspection budget. Target refs and included dirty state are rechecked after preview. Analyst findings and user decisions are separately harness-written local records. Recollecting a completed run verifies and reuses its immutable evidence packet.

## Instruction admission

`AGENTS.md` and rules are treated as scarce always-loaded context. They may contain only one-sentence pure imperative items backed by tracked repository evidence. Examples, explanations, history, summaries, descriptive or subordinate clauses, and code blocks are rejected. Promotion is exceptional and requires substantive criticality, non-obviousness, repeated applicability, concrete failure impact, precise scope, and exact measured context burden. Scoped rules are preferred over root guidance; memory or documentation is preferred for descriptive knowledge.
