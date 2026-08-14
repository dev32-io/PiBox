---
name: plan-delivery
description: Use when converting a coherent high-level story into an execution-ready technical delivery plan for user review.
---

# Plan Delivery

## Goal

Make a coherent high-level story executable in technical terms. Produce the smallest safe contribution plan that uses the workflow system deliberately for correctness, cost, and speed.

## Input Boundary

Enter when high-level intent, scope, acceptance criteria, and design boundaries are coherent and the user has asked to plan or continue planning. Read the current work item and repository before decomposing delivery; do not repeat broad product discovery.

If a new finding changes the product outcome, user-visible behavior, consequential policy, privacy, or explicit scope, return to `shape-story`. Do not bury a product decision in task assumptions.

## Plan the Delivery

1. Inspect only the implementation seams needed to plan this story; zoom into more repository or canonical detail only when a decision depends on it.
2. Resolve technical unknowns that affect feasibility, compatibility, migration, recovery, or verification. Ask only when the answer changes the agreed product contract.
3. Define delivery independently from task count: `feature` for capabilities/refactors, `fix` for defects; `create` from `develop`, or `continue` on the explicitly current feature/fix branch.
4. Draft **tracer-bullet contributions**. Each task must cut a narrow but complete path through the layers and focused tests its behavior needs, produce an independently demoable or verifiable result, and fit one fresh worker context.
5. Keep setup, implementation, tests, and documentation with the behavior that needs them. Use a preparatory task only when it creates a stable seam that materially simplifies later tracer bullets. Use expand–migrate–contract only for wide mechanical changes that cannot remain green as vertical slices.
6. Give every task a short title, what it delivers, observable acceptance, and explicit blockers. Add interfaces, risks, or file/resource claims only where they constrain another task or safe concurrency. Do not turn the task brief into a restatement of the whole story.
7. Arrange blockers into ordered execution stages. Tasks in one stage are the parallel frontier; stages run sequentially. Parallel-stage tasks must not depend on each other and must have compatible resource claims. The runtime—not the planner—executes singleton stages on the feature branch and allocates worktrees for multi-task stages.
8. Assign one capability tier only after task boundaries are settled. The harness resolves the first available configured `provider/model#effort` entry in that tier.
9. Map every binding criterion to contributions and the cheapest meaningful proof. Add deterministic checks, review, regression, migration, or E2E only where risk warrants it.
10. Read the bounded `plan-write` schema, then write the complete draft with `workflow_plan_write`: `create` for a new, fresh, separate, or ignore-previous plan; `update` only when the user explicitly asks to replace that exact plan. Omit harness-owned defaults and optional semantic sections that add no information, but always supply the structured task brief and acceptance fields—the worker context is rendered from them. A `basedOn` plan is read-only context. If identity is genuinely ambiguous, ask one question before writing.
11. Read the whole written plan back with `workflow_get` using `view=full` and the exact returned revision, following continuation offsets until artifact contents, every task brief and acceptance contract, units, and evaluations have been read. Then self-review that durable artifact with fresh eyes; this is your own short checklist, not a subagent dispatch:
   - **Coverage:** point every binding criterion and constraint to an owning task and proof; identify any gap.
   - **Vagueness:** find placeholders and instructions such as “handle edge cases,” “add validation,” or “write tests” that lack an observable contract.
   - **Consistency:** ensure task dependencies, stage IDs, artifact/criterion references, interface names, and produced/consumed contracts agree across the graph.
   If the review finds issues, fix only the affected resources in one revision-pinned `workflow_plan_write` `edit`; do not resend the unchanged plan. Use complete `update` only for an explicitly requested replacement. Do not repeat the self-review.
12. Submit the reviewed plan and hand it to the user. A separate planning critique is optional and runs only when the user explicitly requests it; spawn `plan-critic` through `subagent_spawn` without delaying ordinary plans. Submission is a review handoff, not an execution authorization.

## Capability Tier Protocol

Every new task assignment chooses one semantic tier: `low | medium | high | max`. Use `medium` by default.

- **low:** pure mechanical, deterministic, low-risk work such as copy, colors, generated updates, or straightforward documentation.
- **medium:** normal implementation with clear scope, known interfaces, and bounded decisions. This should cover most tasks.
- **high:** complex algorithms, broad integration, difficult state/control flow, or substantial technical uncertainty that remains after decomposition.
- **max:** architecture, security, privacy, irreversible or high-blast-radius changes, large-scale system boundaries, or unusually ambiguous work where the strongest configured route is warranted.

A tier is an ordered list of concrete `provider/model#effort` pairs. The planner does not separately guess reasoning effort or pin a task model; the configured pair is the routing policy. A user may still explicitly choose model and effort for a free-form `subagent_spawn` call.

## Readiness Gate

Use the read-after-write self-review above as the single pre-submission gate. Verify that:

- every task advances the story, has one dominant concern, and is bounded enough for one model context;
- no task relies on model strength or reasoning effort to hide avoidable scope;
- any single-task multi-dimensional story has an explicit decomposition analysis;
- each task is a tracer bullet that fits one fresh context and has explicit blockers;
- tasks in one stage are genuinely independent and compatible; execution isolation is not encoded in task plans;
- intermediate and assembled states are meaningful;
- plan identity matches the user's explicit create/update wording;
- acceptance criteria have sufficient implementation and verification coverage;
- the capability tier matches the bounded work;
- no material product or technical decision remains hidden.

Refine the story plan with the user whenever new constraints surface. Do not submit while a material decision remains unresolved.

## Review Handoff

When execution-ready, call `workflow_transition` with `submit`. Present the work-item ID, outcome and scope, technical approach, contribution stages, parallelism choices, assignments, verification, and residual risks.

Offer natural next steps: conversational refinement, targeted changes, or execution. Make clear that the user can say “start the workflow” or otherwise explicitly request execution, which is the sole execution gate and hands off to `workflow-run`; no separate approval command is required.

## Deliverable

End with exactly one result:

1. a submitted execution-ready story plan and review handoff;
2. one material technical or product decision blocking submission; or
3. an explicit return to `shape-story` with the contract issue that must be resolved.

Never end with “I can plan or submit next” after this phase is active.
