# Execution Roadmap

## Design Goal

Deliver canonical safety and repository-local isolation first, then structured artifacts, followed by independent prompt refinement in workflow order. Preserve a usable harness after each integration unit and make every prompt regression attributable to one change.

## Chosen Approach

Execute serial integration units with incremental commits. Mechanical safety and checkout locality land before artifact and prompt changes. Artifact infrastructure lands before prompts because rewritten prompts depend on the new vocabulary, tool contracts, and completion shapes. Prompt scenario infrastructure lands before the first prompt rewrite. Each prompt surface receives its own baseline, rewrite, rerun, and acceptance commit.

### Integration unit 1: canonical safety

- Wrap every canonical mutation's complete validation/write/catalog/revision/commit transaction in the repository mutex.
- Preserve idempotent replay and dirty-canonical failure.
- Add simultaneous mutation regression tests proving complete commits without `.git/index.lock` races; scheduler arrival order is not part of the contract.

### Integration unit 2: repository-local worktrees

- Resolve new task checkouts under `<canonical-repository>/.worktree/pibox/<work-item>/<task>`.
- Extend harness initialization and preparation to preserve `.gitignore` content while idempotently ensuring an effective root `/.worktree/` ignore rule.
- Verify the allocation target is ignored before `git worktree add`; fail with preparation guidance instead of mutating an approved branch implicitly.
- Preserve recovery of legacy external worktrees through recorded runtime paths without automatic movement or deletion.
- Update linked-worktree, allocation, scaffold, recovery, documentation, and E2E tests.

### Integration unit 3: artifact contracts

- Implement the versioned contract registry, substantive-content validation, declared conditional triggers, qualified criterion references, and deterministic renderers.
- Add typed schema-v2 inputs and schema-v1 read/completion compatibility for intent, specification, design, decision, task brief, and task acceptance.
- Extend task and evaluation manifests with structured criterion references.
- Render evaluation reports and outcomes from structured handoffs and canonical state.
- Update operating documentation and migration guidance.
- Run unit, store, lifecycle, traceability, compatibility, concurrency, and Git integration tests.

### Integration unit 4: prompt evaluation foundation

- Add the authoritative prompt registry with paths/symbols and discovery tests that fail on unclassified additions.
- Define prompt contracts and trigger-only description rules.
- Add fixed scenario fixtures, prompt/config/scenario digests, private transcript storage, aggregate result records, and a comparison command.
- Establish current baselines with the configured Luna alias before changing prompts.

### Prompt-surface integration units

Refine and accept one surface at a time:

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
18. harness-init.

Every prompt unit:

- resolves and records one model/config pairing for baseline and candidate;
- runs unchanged baseline scenarios against the prior prompt;
- records observed failure labels and turn/protocol metrics;
- rewrites only the selected surface;
- reruns the same scenarios and applies the thresholds in `prompt-refinement-method`;
- passes static prompt-contract checks and relevant supervised-child tests;
- commits before the next surface begins.

### Exceptional pointers

Refine protocol nudges, fallback prompts, skill descriptions, and tool-description context pointers. Remove duplicated process text and derive artifact contract summaries from the registry where practical.

### Final assembly

- Run the complete offline suite, package dry-run, audit, and diff checks.
- Run one adversarial whole-prompt review using the strongest configured available role candidate.
- Run one economy-profile managed lifecycle E2E covering natural-language routing, structured planning, direct approval, repository-local isolated implementation, evaluation evidence, outcome rendering, and clean Git state.
- Run one focused interruption/resume scenario for the changed recovery prompt using the same small fixture rather than expanding the lifecycle E2E.
- Record model turns, elapsed time, and protocol outcomes. The final model-run budget is one lifecycle run, one focused recovery run, and one repair rerun only if a blocking finding is accepted.

## Components and Interfaces

Canonical safety affects mutation wrappers and repository locking. Repository-local isolation affects `WorktreeManager`, repository discovery, scaffold/preparation, recovery, tests, and documentation. Artifact-contract implementation primarily affects `work-items.ts`, `types.ts`, capability schemas, worker/evaluator handoffs, and new focused registry/renderer modules. Prompt work affects `skills/harness-*`, `extensions/harness/roles`, dynamic prompt builders, and new registry, scenario fixtures, and test helpers.

Each prompt unit consumes the accepted artifact vocabulary and prompt rubric. Later prompt units do not modify earlier prompts except through a separately recorded regression fix.

## Data and Control Flow

1. Canonical serialization makes planning and implementation mutations safe.
2. Repository preparation establishes the ignored local checkout root; allocation creates task worktrees there.
3. Artifact contracts establish typed inputs and rendered outputs.
4. Scenario infrastructure captures reproducible baseline behavior.
5. Prompt units progress along the real workflow chain.
6. Final assembly proves the lifecycle and recovery boundary separately.

## Failure and Recovery

A missing ignore rule blocks allocation before creating a directory. Existing legacy worktrees remain usable through recorded paths. A failed artifact integration unit leaves schema-v1 behavior intact until the candidate passes. A failed prompt candidate is reverted or corrected within its unit before later prompts begin. Capacity failures invalidate a comparison pair and do not count as semantic prompt failures. Private scenario transcripts and aggregate digests allow interrupted comparisons to resume. Every integration unit has an independently identifiable commit range.

## Security and Privacy

Synthetic scenario repositories contain no secrets. Repository-local worktrees contain ordinary task checkouts and remain ignored; credentials, transcripts, run records, locks, and receipts remain in private home-directory state. Typed renderers do not execute Markdown. Tool authority and role tool sets remain unchanged by prompt edits.

## Compatibility and Migration

Recorded legacy external worktree paths remain supported. New allocations use `.worktree/pibox/`. Schema-v1 work items remain readable and completable under their approved contracts. New work items use schema-v2 structured artifacts after the artifact-contract unit lands. Repository-local custom prompts continue working; linting is advisory unless repository policy opts into strict validation.

## Verification Boundaries

- Canonical safety: concurrent Git integration test.
- Worktree locality: scaffold, ignore, linked-worktree, allocation, and legacy recovery integration tests.
- Artifact contracts: required combined review of registry, renderers, compatibility, and traceability.
- Each prompt surface: fixed behavioral scenario gate plus relevant deterministic tests.
- Prompt assembly: independent standards/spec review of all prompt diffs and aggregate scenario results.
- Final harness: one bounded managed lifecycle E2E plus one focused recovery scenario.

## Alternatives Considered

A single artifact-and-prompt integration unit was rejected because it would be too large to diagnose or review. Global task checkouts were rejected because they are repository-owned working material, not private harness state. Defining new prompts before typed artifacts was rejected because prompt completion contracts would target unstable document shapes. Independent evaluator runs for every tiny prompt edit were rejected as disproportionate; fixed behavioral scenarios provide the local gate, with independent review at meaningful assembled boundaries. One oversized E2E was rejected because failures would be expensive and weakly attributable.
