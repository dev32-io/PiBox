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

1. Inspect only the implementation seams needed to plan this story; zoom into more repository or canonical detail only when a decision depends on it.
2. Resolve technical unknowns that affect feasibility, compatibility, migration, recovery, or verification. Ask only when the answer changes the agreed product contract.
3. Define delivery independently from task count: `feature` for capabilities/refactors, `fix` for defects; `create` from `develop`, or `continue` on the explicitly current feature/fix branch.
4. Draft **tracer-bullet contributions**. Each task must cut a narrow but complete path through the layers and focused tests its behavior needs, produce an independently demoable or verifiable result, and fit one fresh worker context.
5. Keep setup, implementation, tests, and documentation with the behavior that needs them. Use a preparatory task only when it creates a stable seam that materially simplifies later tracer bullets. Use expand–migrate–contract only for wide mechanical changes that cannot remain green as vertical slices.
6. Give every task a short title, what it delivers, observable acceptance, and explicit blockers. Add interfaces, risks, or file/resource claims only where they constrain another task or safe concurrency. Do not turn the task brief into a restatement of the whole story.
7. Present the proposed task graph to the user before publishing it. Ask whether granularity and blocking edges are right and whether anything should merge or split. Preserve the user's freedom to prefer a coarser or finer graph unless safety or context fit makes it untenable.
8. Arrange blockers into ordered execution stages. Tasks in one stage are the parallel frontier; stages run sequentially. Parallel-stage tasks must not depend on each other and must have compatible resource claims. The runtime—not the planner—executes singleton stages on the feature branch and allocates worktrees for multi-task stages.
9. Assign capability tier and deliberation only after task boundaries are settled. The harness selects provider, concrete model, and model-specific effort.
10. Map every binding criterion to contributions and the cheapest meaningful proof. Add deterministic checks, review, regression, migration, or E2E only where risk warrants it.
11. Use an unanchored plan critic for material ambiguity, topology, or context-fit risk. Ask it to judge the proposed graph rather than ratify a preferred task count; use the configured critic routing unless the user explicitly overrides it.
12. Publish the user-reviewed graph through canonical capabilities. Use compact summaries first, bounded detail reads when needed, and coherent batch mutation only when the resources form one decision.

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
- each task is a tracer bullet that fits one fresh context and has explicit blockers;
- tasks in one stage are genuinely independent and compatible; execution isolation is not encoded in task plans;
- intermediate and assembled states are meaningful;
- acceptance criteria have sufficient implementation and verification coverage;
- capability tier and deliberation match the bounded work;
- no material product or technical decision remains hidden.

Refine the story plan with the user whenever new constraints surface. Do not publish tickets until the user has reviewed granularity and blockers, and do not submit while a material decision remains unresolved.

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
