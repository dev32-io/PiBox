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
4. Decompose the story into context-bounded contributions before assigning execution capability. A task is the authoritative context capsule for one model attempt, not merely a scheduling unit.
5. Keep implementation and focused tests for one concern together. Split when a candidate task spans independently understandable feature areas, unrelated reasoning modes, several primary risks, most story criteria, or so much of the repository that its brief must restate the whole story. Do not use a stronger model or deeper deliberation to compensate for an oversized task.
6. Keep work together when splitting would duplicate most context, create an unstable interface, or divide one invariant across workers. Every split must reduce context or create a meaningful dependency, isolation, verification, or recovery boundary; task count is not a goal.
7. Give each task one dominant contribution goal and primary failure boundary, plus included and excluded scope, dependencies and interfaces, required work, expected intermediate state, integration expectation, risks, and cheapest meaningful proof. Its brief must be sufficient without unrelated story areas.
8. Order stages by real dependencies. Sequential stages are valuable when they let later tasks build on a small stable foundation; parallel stages are valuable only when interfaces and resource claims are compatible and the speed benefit repays coordination and worktree cost. State why each stage is sequential or parallel.
9. Select repository or worktree isolation intentionally. Prefer repository isolation for serial branch work and worktrees for genuine isolation or concurrency.
10. Assign a capability tier and deliberation profile only after decomposition, using the protocol below. The harness—not the planner—selects provider, concrete model, and model-specific effort from configuration.
11. Map every binding acceptance criterion to task contributions and verification. Add deterministic checks, independent review, regression, migration, or E2E evaluation only where the risk warrants it.
12. Use a plan critic for consequential ambiguity, blast radius, or decomposition risk—and whenever a multi-dimensional story is proposed as one task. Refine findings into the plan rather than adding ceremony.
13. Use `workflow_apply_change` for genuinely coherent multi-resource revisions. Keep canonical resources internally consistent and avoid replacement duplicates.

## Capability and Deliberation Protocol

Every new task assignment chooses two semantic values:

- **tier:** `low | medium | high | max` — the minimum model capability required;
- **deliberation:** `standard | deep` — the reasoning budget required after the task has been properly bounded.

Use `medium/standard` by default.

- **low:** mechanical, deterministic, low-risk work such as copy, colors, generated updates, or straightforward documentation.
- **medium:** normal engineering with clear scope, known interfaces, and bounded implementation decisions. This should cover most tasks.
- **high:** complex algorithms, broad integration, difficult state/control flow, or substantial technical uncertainty that remains after decomposition.
- **max:** architecture, security, privacy, irreversible or high-blast-radius changes, large-scale system boundaries, or unusually ambiguous work where the strongest configured capability is warranted.
- **standard:** the contract and interfaces are clear enough for ordinary implementation reasoning.
- **deep:** the bounded task still requires long reasoning chains, complex debugging, concurrency analysis, security reasoning, migration design, or consequential trade-offs.

Capability and deliberation are orthogonal: a security-sensitive but exact patch may be `max/standard`; a subtle bounded race diagnosis may be `high/deep`. Never select raw provider, model, or effort in an ordinary plan. When the user explicitly pins a configured concrete model or effort, preserve it through the optional assignment `modelOverride` and cite it as a user constraint; never manufacture an override from planner preference.

## Readiness Review

Before submission, verify that:

- every task advances the story, has one dominant concern, and is bounded enough for one model context;
- no task relies on model strength or deep deliberation to hide avoidable scope;
- any single-task multi-dimensional story has an explicit decomposition analysis and critic justification;
- dependencies, ordering, parallelism, resource claims, and the reason for each stage shape are explicit;
- intermediate and assembled states are meaningful;
- acceptance criteria have sufficient implementation and verification coverage;
- capability tier and deliberation match the bounded work;
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
