# Execution Roadmap

## Design Goal

Deliver structured canonical artifacts first, then refine every prompt surface independently in workflow order. Preserve a usable harness after each integration unit and make every prompt regression attributable to one change.

## Chosen Approach

Execute serial integration units with incremental commits. Artifact infrastructure lands before prompts because rewritten prompts depend on the new vocabulary, tool contracts, and completion shapes. Prompt scenario infrastructure lands before the first prompt rewrite. Each prompt surface receives its own baseline, rewrite, rerun, and acceptance commit.

### Integration unit 1: canonical safety

- Serialize all canonical mutation capabilities across concurrent invocations before Git operations.
- Add a regression that invokes simultaneous artifact mutations and proves deterministic commits without `.git/index.lock` races.

### Integration unit 2: artifact contracts

- Implement the versioned contract registry, substantive-content validation, conditional triggers, qualified criterion references, and deterministic renderers.
- Add typed inputs and schema-v1 compatibility for intent, specification, design, decision, task brief, and task acceptance.
- Extend task and evaluation manifests with structured criterion references.
- Render evaluation reports and outcomes from structured handoffs and canonical state.
- Update operating documentation and migration guidance.
- Run unit, store, lifecycle, traceability, compatibility, and Git integration tests.

### Integration unit 3: prompt evaluation foundation

- Inventory every built-in prompt surface and fail tests on unclassified additions.
- Define the prompt contract and trigger-only description rules.
- Add fixed scenario fixtures, prompt/config/scenario digests, private transcript storage, aggregate result records, and a comparison command.
- Establish current baselines with Luna before changing prompts.

### Integration units 4–21: prompt surfaces

Refine and accept one surface at a time in this order:

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

Every unit:

- runs unchanged baseline scenarios against the prior prompt;
- records observed failure labels and turn/protocol metrics;
- rewrites only the selected surface;
- reruns the same scenarios;
- passes static prompt-contract checks and relevant supervised-child tests;
- commits before the next surface begins.

### Integration unit 22: exceptional pointers

Refine protocol nudges, fallback prompts, skill descriptions, and tool-description context pointers. Remove duplicated process text and derive artifact contract summaries from the registry where practical.

### Integration unit 23: final assembly

Run the full offline suite, package and audit checks, adversarial prompt review on a stronger model, and a fresh economy-profile managed E2E covering natural-language routing, structured planning, direct approval, isolated implementation, evaluation evidence, outcome rendering, interruption, and recovery.

## Components and Interfaces

Artifact-contract implementation primarily affects `work-items.ts`, `types.ts`, capability schemas, worker/evaluator handoffs, and new focused registry/renderer modules. Prompt work affects `skills/harness-*`, `extensions/harness/roles`, dynamic prompt builders in supervisor and orchestration code, and new scenario fixtures and test helpers. Documentation points to the registry and scenario command rather than duplicating contracts.

Each prompt unit consumes the accepted artifact vocabulary and prompt rubric. Later prompt units do not modify earlier prompts except through a separately recorded regression fix.

## Data and Control Flow

1. Canonical serialization makes planning and implementation mutations safe.
2. Artifact contracts establish typed inputs and rendered outputs.
3. Scenario infrastructure captures baseline behavior.
4. Prompt units progress along the real workflow chain.
5. Final E2E proves the assembled chain and captures any residual findings.

## Failure and Recovery

A failed artifact integration unit leaves schema-v1 behavior intact until the candidate passes. A failed prompt candidate is reverted or corrected within its unit before later prompts begin. Capacity failures do not count as semantic prompt failures. Private scenario transcripts and aggregate digests allow interrupted comparisons to resume. Every integration unit has an independently identifiable commit range.

## Security and Privacy

Synthetic scenario repositories contain no secrets. Typed renderers do not execute Markdown. Tool authority and role tool sets remain unchanged by prompt edits. Any proposed authority expansion requires a separate decision and capability test.

## Compatibility and Migration

Schema-v1 work items remain readable and completable under their approved contracts. New work items use schema-v2 structured artifacts after the artifact-contract unit lands. Repository-local custom prompts continue working; linting is advisory for custom prompts unless repository policy opts into strict validation.

## Verification Boundaries

- Canonical safety: concurrent Git integration test.
- Artifact contracts: required combined review of registry, renderers, compatibility, and traceability.
- Each prompt surface: fixed behavioral scenario gate plus relevant deterministic tests.
- Prompt assembly: independent standards/spec review of all prompt diffs and aggregate scenario results.
- Final harness: required managed E2E with canonical artifacts, private run records, evidence checksums, and clean Git state.

## Alternatives Considered

A single artifact-and-prompt integration unit was rejected because it would be too large to diagnose or review. Defining new prompts before typed artifacts was rejected because prompt completion contracts would target unstable document shapes. Independent evaluator runs for every tiny prompt edit were rejected as disproportionate; fixed behavioral scenarios provide the local gate, with independent review at meaningful assembled boundaries.
