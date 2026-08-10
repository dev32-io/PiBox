# Prompt Refinement Method

## Design Goal

Replace generic role-playing and list-only harness prompts with compact instruction contracts that produce reliable routing, bounded work, structured handoffs, and evidence-backed completion. This design addresses `prompt-and-artifact-contracts#AC-001` through `AC-004`, `AC-012`, and `AC-014`.

## Chosen Approach

Use prompt TDD one surface at a time: establish a no-change baseline, classify observed failures, rewrite the minimum instructions needed, rerun identical scenarios, and refine only against remaining variance. Keep mechanical invariants in capabilities. Use the configured Luna alias for repeated scenarios and stronger judgment only for final adversarial review.

Apply these writing rules:

- Start with the action or boundary, not an identity such as `You are ...`.
- State inputs and their authority before procedure.
- Use positive target behavior; reserve prohibitions for hard guardrails that cannot be expressed positively.
- Separate ordered steps from reference material.
- Give each step an observable completion criterion.
- Use trigger-only skill descriptions as context pointers.
- Use progressive disclosure for branch-specific guidance.
- Keep one source of truth; dynamic prompts reference role contracts and capabilities rather than restating them.
- Use compact leading words consistently: boundary, evidence, criterion, finding, decision, integration unit, residual risk, and tracer-bullet contribution.
- Delete no-op explanation and examples unless baseline tests prove an example changes behavior.

Reference influences are pinned to Superpowers 6.2.0, GitHub Spec Kit commit `9d15554c08ac5d01dc669dbd1a161a9638bc673b`, and Matt Pocock Skills commit `84fdeffd12f2ee307994d1eb6feb48173b6e0502`.

## Components and Interfaces

### Compact orchestrator contract

Inject a small main-session contract through Pi's agent-start system-prompt hook. It defines user authority, ad-hoc versus managed routing, current-phase selection, skill disclosure, canonical ownership, approval, and evidence-backed completion. Detailed research, planning, execution, evaluation, and recovery procedures remain in their skills.

### Authoritative prompt inventory

Commit one registry entry per surface with stable ID, category, source path or source symbol, invocation mode, required tools, completion protocol, and scenario IDs. Discovery scans these authoritative roots and symbols:

- `skills/harness-*/SKILL.md`;
- `extensions/harness/roles/*.md`;
- named dynamic prompt builders in `extensions/harness/supervisor.ts`, `extensions/harness/direct-agent.ts`, and `extensions/harness/index.ts`;
- registered harness tool descriptions in `extensions/harness/index.ts`, `worker-capabilities.ts`, and `evaluator-capabilities.ts`.

Static tests fail when discovery finds an unregistered surface or a registry path/symbol no longer exists.

### Prompt contracts

Each registry entry records invocation context, authoritative inputs, instructions, completion criteria, escalation criteria, and hard authority limits only where necessary. Skill descriptions contain trigger conditions only. Prompt source files are validated as prompt code, not rendered through canonical artifact profiles.

### Scenario corpus and rubric

Store fixed scenarios and expected behavioral properties, not preferred prose. Score binary properties for:

- correct workflow routing;
- authoritative source inspection;
- boundary discipline;
- artifact or handoff completeness;
- criterion and evidence quality;
- escalation correctness;
- premature completion;
- unnecessary work or ceremony;
- tool protocol compliance.

Record turns and retained transcript size as efficiency metrics. Every result records alias, resolved provider/model, effort, prompt digest, config digest, scenario digest, attempt, outcome, and observed failure labels.

For each scenario, baseline and candidate use the same resolved model, effort, repository fixture, and config digest. Capacity or provider failures invalidate the pair and are retried later; they are not semantic failures. Wording-sensitive and discipline scenarios run five fresh-context repetitions per variant. Deterministic protocol scenarios run three.

Acceptance thresholds:

- Critical properties—authority, destructive scope, approval, canonical ownership, and terminal handoff—pass every candidate repetition.
- Other required properties pass at least four of five repetitions, or every repetition in a three-run protocol scenario.
- No property that already passed every baseline repetition may regress.
- Median turns may not increase by more than twenty percent unless the candidate fixes a previously failing required property; the aggregate record must state that trade-off.
- Every flagged result is read and adjudicated; aggregate counts alone do not accept a prompt.

## Data and Control Flow

For each prompt surface:

1. Resolve the configured Luna alias and pin its provider, model, effort, and config digest for the baseline/candidate pair.
2. Run representative and pressure scenarios against the existing prompt.
3. Preserve exact prompts, routing, transcript, and scored observations privately; commit concise scenario definitions and aggregate results.
4. Classify failures as routing, discipline, output-shape, omission, ambiguity, or no-op/sprawl.
5. Select wording form: positive recipe for output shape, structural field for omission, observable condition for branching, or hard guardrail plus rationalization defense only for demonstrated discipline failures.
6. Rewrite one surface without changing unrelated prompts.
7. Rerun the same scenarios and apply the acceptance thresholds.
8. Commit only after the surface meets its rubric; then move to the next surface.

Refinement order:

1. compact orchestrator contract;
2. harness-research;
3. explorer;
4. researcher;
5. harness-plan;
6. plan-critic;
7. harness-execute;
8. supervised-task dynamic prompt;
9. implementer;
10. test-implementer;
11. harness-evaluate;
12. evaluator dynamic prompt;
13. spec-reviewer;
14. quality-reviewer;
15. e2e-tester;
16. repair-implementer;
17. harness-recover;
18. harness-init;
19. protocol, fallback, and tool-description pointers;
20. final managed E2E.

## Failure and Recovery

Scenario runs retain prompt and transcript digests so interrupted evaluation can resume without losing comparison context. A prompt that improves one scenario but regresses another remains unaccepted unless the explicit efficiency exception applies. Provider and capacity failures remain separate from semantic results. Prompt commits are isolated so any regression can be reverted without undoing artifact-contract infrastructure.

## Security and Privacy

Scenario fixtures contain synthetic repositories and no secrets. Private transcripts remain outside Git. Committed aggregate results exclude credentials and sensitive provider payloads. Prompt changes cannot widen role tools or authority without an explicit design update and capability test.

## Compatibility and Migration

Repository-local custom role prompts remain supported and may opt into prompt linting; built-in prompt validation is strict. Existing skill names remain stable. The orchestrator injection is compact and does not require managed ceremony for ad-hoc work. Tool and role configuration semantics remain unchanged unless a separate approved contract says otherwise.

## Verification Boundaries

- Static tests inventory every built-in prompt surface and reject unclassified additions.
- Prompt contract tests check identity-preamble removal, trigger-only descriptions, required completion/escalation slots, and duplicate instruction sources.
- Behavioral scenario runs gate each individual rewrite outside normal offline CI.
- Supervised-child tests verify structured terminal handoffs after worker and evaluator prompt changes.
- Final E2E covers natural-language routing through approval, execution, evaluation, and completion; focused recovery scenarios cover interruption and resume.

## Alternatives Considered

Rewriting all prompts in one batch was rejected because regressions could not be attributed. Pure editorial review was rejected because plausible wording does not prove model behavior. Large always-loaded orchestration instructions were rejected because they spend context on branches that do not apply. Copying any reference framework wholesale was rejected because PiBox preserves proportional boundaries and capability-backed truth rather than universal ceremony.
