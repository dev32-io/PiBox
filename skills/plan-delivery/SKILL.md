---
name: plan-delivery
description: Use when converting a coherent high-level story into an execution-ready technical delivery plan for user review and approval.
---

# Plan Delivery

## Goal

Make a coherent high-level story executable in technical terms. Produce the smallest safe contribution plan that uses the workflow system deliberately for correctness, cost, and speed.

## Input Boundary

Enter when high-level intent, scope, acceptance criteria, and design boundaries are coherent and the user has asked to plan or continue planning. Read the current work item and repository before decomposing delivery; do not repeat broad product discovery.

If a new finding changes the product outcome, user-visible behavior, consequential policy, privacy, or explicit scope, return to `shape-story`. Do not bury a product decision in task assumptions.

## Plan the Delivery

1. Inspect the implementation, tests, build system, repository conventions, and relevant integration boundaries.
2. Resolve technical unknowns that affect feasibility, decomposition, compatibility, migration, failure recovery, or verification. Ask only when the choice is material to the user or changes the agreed product contract.
3. Define delivery independently from work-item size:
   - `feature` for capabilities, enhancements, and refactors; `fix` for defects or regressions;
   - `create` from updated `develop`, or `continue` on the explicitly current feature/fix branch.
4. Design coherent vertical contributions. Keep tiny or tightly coupled work together. Split only where a contribution has a meaningful boundary and independently understandable result.
5. Order stages by real dependencies. Run tasks in parallel only when their interfaces and resource claims are compatible and the expected speed or isolation benefit repays coordination and worktree cost.
6. Give each task an explicit contribution goal, included and excluded boundary, dependencies and interfaces, required work, expected intermediate state, integration expectation, risks, and cheapest meaningful proof.
7. Select repository or worktree isolation intentionally. Assign role, model, effort, minimum capability, and fallback policy according to task complexity and risk rather than habit.
8. Map every binding acceptance criterion to task contributions and verification. Add deterministic checks, independent review, regression, migration, or E2E evaluation only where the risk warrants it.
9. Use a plan critic only for consequential ambiguity, blast radius, or decomposition risk. Refine findings into the plan rather than adding ceremony.
10. Use `workflow_apply_change` for genuinely coherent multi-resource revisions. Keep canonical resources internally consistent and avoid replacement duplicates.

## Readiness Review

Before submission, verify that:

- every task advances the story and has a coherent mergeable boundary;
- dependencies, ordering, parallelism, and resource claims are explicit;
- intermediate and assembled states are meaningful;
- acceptance criteria have sufficient implementation and verification coverage;
- model cost and capability match the work;
- no material product or technical decision remains hidden.

Refine the story plan with the user whenever new constraints surface. A planning turn may span many conversational turns; do not submit while a material decision remains unresolved.

## Approval Handoff

When execution-ready, call `workflow_transition` with `submit`. Present the work-item ID, outcome and scope, technical approach, contribution stages, parallelism choices, assignments, verification, residual risks, and the exact command:

> `/workflow approve <work-item-id>`

Offer natural next steps: conversational refinement, targeted changes, or approval. Make clear that approval does not itself start delivery; after approval the user can say “start the workflow” or otherwise explicitly request execution, which hands off to `workflow-run`.

## Deliverable

End with exactly one result:

1. a submitted execution-ready story plan and approval handoff;
2. one material technical or product decision blocking submission; or
3. an explicit return to `shape-story` with the contract issue that must be resolved.

Never end with “I can plan or submit next” after this phase is active.
