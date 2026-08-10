# Prompt Refinement Method

## Design Goal

Replace generic role-playing and list-only harness prompts with compact instruction contracts that produce reliable routing, bounded work, structured handoffs, and evidence-backed completion. This design addresses `prompt-and-artifact-contracts#AC-001` through `AC-004`, `AC-012`, and `AC-014`.

## Chosen Approach

Use prompt TDD one surface at a time: establish a no-change baseline, classify observed failures, rewrite the minimum instructions needed, rerun identical scenarios, and refine only against remaining variance. Keep mechanical invariants in capabilities. Use Luna for repeated scenarios and stronger judgment only for final adversarial review.

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

### Prompt contract registry

Inventory and classify every surface:

- Skills: harness-research, harness-plan, harness-execute, harness-evaluate, harness-recover, harness-init.
- Roles: explorer, researcher, plan-critic, implementer, test-implementer, spec-reviewer, quality-reviewer, e2e-tester, repair-implementer.
- Dynamic prompts: supervised task and planned evaluator.
- Exceptional prompts: protocol nudges and missing-role fallback.
- Context pointers: skill descriptions and tool descriptions.

Each surface records invocation context, available inputs/tools, instructions, completion contract, escalation contract, and prohibited authority only where mechanically necessary.

### Scenario corpus and rubric

Store fixed scenarios and expected behavioral properties, not preferred prose. Score:

- correct workflow routing;
- authoritative source inspection;
- boundary discipline;
- artifact or handoff completeness;
- criterion and evidence quality;
- escalation correctness;
- premature completion;
- unnecessary work or ceremony;
- tool protocol compliance;
- turns and retained transcript size.

Record baseline and candidate results with model, effort, prompt digest, config digest, scenario digest, outcome, and observed failure labels.

## Data and Control Flow

For each prompt surface:

1. Run representative and pressure scenarios against the existing prompt.
2. Preserve exact prompts, model routing, transcript, and scored observations privately; commit concise scenario definitions and aggregate results.
3. Classify failures as routing, discipline, output-shape, omission, ambiguity, or no-op/sprawl.
4. Select wording form: positive recipe for output shape, structural field for omission, observable condition for branching, or hard guardrail plus rationalization defense only for demonstrated discipline failures.
5. Rewrite one surface without changing unrelated prompts.
6. Rerun the same scenarios and compare behavior, turns, and protocol success.
7. Commit only after the surface meets its rubric; then move to the next surface.

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

Scenario runs retain prompt and transcript digests so interrupted evaluation can resume without losing comparison context. A prompt that improves one scenario but regresses another remains unaccepted. Provider or capacity failures are recorded separately from semantic failures. Prompt commits are isolated so any regression can be reverted without undoing artifact-contract infrastructure.

## Security and Privacy

Scenario fixtures contain synthetic repositories and no secrets. Private transcripts remain outside Git. Committed aggregate results exclude credentials and sensitive model payloads. Prompt changes cannot widen role tools or authority without an explicit design update and capability test.

## Compatibility and Migration

Repository-local custom role prompts remain supported but can be linted against the prompt contract. Existing skill names remain stable. The orchestrator injection is compact and does not require managed ceremony for ad-hoc work. Tool and role configuration semantics remain unchanged unless a separate approved contract says otherwise.

## Verification Boundaries

- Static tests inventory every built-in prompt surface and reject unclassified additions.
- Prompt contract tests check identity-preamble removal, trigger-only descriptions, required completion/escalation slots, and duplicate instruction sources.
- Behavioral scenario runs gate each individual rewrite outside normal offline CI.
- Supervised-child tests verify structured terminal handoffs after worker and evaluator prompt changes.
- Final E2E covers natural-language routing through approval, execution, evaluation, completion, and recovery.

## Alternatives Considered

Rewriting all prompts in one batch was rejected because regressions could not be attributed. Pure editorial review was rejected because plausible wording does not prove model behavior. Large always-loaded orchestration instructions were rejected because they spend context on branches that do not apply. Copying any reference framework wholesale was rejected because PiBox preserves proportional boundaries and capability-backed truth rather than universal ceremony.
