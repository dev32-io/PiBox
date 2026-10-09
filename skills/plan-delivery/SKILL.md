---
name: plan-delivery
description: Use when converting a coherent high-level story into an execution-ready technical delivery plan for user review.
---

# Plan Delivery

Turn a reviewed story into self-contained fresh-agent assignments arranged in ordered stages. Story review, plan review, and execution start are separate authority boundaries.

## Enter

Read the complete rendered story and E2E matrix and treat their Markdown as binding. If repository evidence exposes a product-contract problem, return to `shape-story`, update only the affected story section or E2E case, then continue.

## Execution Model

A plan is an ordered stage train. Every stage declares `mode: sequential` or `mode: concurrent`.

- A **concurrent stage** fans independent tasks into per-task worktrees from one pinned base and integrates them through one barrier. Its tasks cannot depend on one another or claim incompatible shared resources.
- A **sequential stage** runs tasks one after another in one isolated stage workspace, so each fresh agent sees the prior task's commits.

Later stages start from the integrated output of earlier stages. Tasks are fresh-agent boundaries, not implementation steps; a multi-task sequential stage is an exceptional baton pass. The planner authors tasks, stages, deterministic checks, and optional stage review policy, never evaluations, reports, handoffs, repair tasks, or retry limits.

## Plan the Delivery

1. **Map the seams** — Inspect the responsibilities, entry points, data and control flow, compatibility constraints, migrations, and proof seams the story touches. Confirm the story's working branch and do not switch branches while planning.
2. **Choose fresh-agent boundaries** — Keep coupled discovery, invariants, implementation, and focused proof together. Split only at coherent independent seams, durable predecessor outputs, or unrelated problem domains. Never create proof-only, review-only, repair-only, or verification-only tasks.
3. **Write minimal complete tasks** — Each task has metadata, Markdown-rich `description`, `scope`, and `delivery` (defined by the `task_write` parameters), and deterministic `checks` the harness runs. The assignment must fit one fresh agent without dereferencing story artifacts or narrative block references. Keep prose proportional; do not repeat the same requirement in every field.
4. **Arrange ordered stages** — Put every independent, resource-compatible task that can start from one base in the same concurrent stage. Add a later stage only for a true dependency on integrated output. Use a multi-task sequential stage only when each task warrants a fresh context but must consume prior commits or cannot safely run concurrently.
5. **Route capability after decomposition** — Default to `medium`. Use `low` for bounded lookup, extraction, routine verification, or mechanical low-risk work. `local` requires current explicit user permission recorded in `rationale`. High/max require `tierJustification` explaining why medium is insufficient and why further decomposition would damage the seam. High is the normal ceiling for hard work. Use `max` only when High is observed or concretely expected to fail; also name the reasoning bottleneck, why better context, tools, or safe decomposition cannot resolve it, and what Max should improve. Size, importance or security labels, urgency, uncertainty, one failed attempt, or the Nuke profile alone do not justify Max; when unsure, choose High.
6. **Plan proof and review risk** — Reconcile task and stage checks and final E2E with the complete story. Set `reviewMode` to `required` for material security/privacy, identity, persistence/data-integrity, concurrency/lifecycle, public compatibility, platform, irreversible, or weakly observable boundaries; use `skip` only when direct deterministic checks fully cover a local, reversible boundary. `reviewFocus` needs a review mode. `.pi/harness.yaml` `limits.repairRounds` is the sole retry-limit authority.

## Write Draft Resources

Work on the story's clean bound branch; the writers commit. Dangling dependencies and incomplete stage membership are fine while drafting. After writing, inspect the resources and correct only the affected one.

Example task: description "Connect checkout through the existing command boundary"; scope "Own the adapter and focused tests; exclude settlement"; delivery "Create one order for valid input, preserve typed rejection, and prove success, rejection, and duplicate submission"; check `npm test -- checkout-command`.

## Readiness Check

Before compiling, verify that:

- every task is a complete, bounded fresh-agent context with no narrative pointers;
- concurrent peers are independent;
- checks sit at the cheapest executable boundary and review policy matches risk; and
- every story behavior has an owner and a proof path.

## Compile for Plan Review

Call near-zero-argument `workflow_compile` without resending authored content. Fix the named resources and recompile. Success yields the content for plan review; it creates no handoff artifact and starts nothing.

## Plan Review and Start Authority

Present the story identity, technical approach, ordered stages, concurrency, capability choices, checks, review decisions, final E2E coverage, and residual risks, then wait for explicit plan review. Planning and successful compilation do not inherit authority from story approval and do not authorize execution.

Only a later explicit request such as "start the workflow" enters `workflow-run`. A request to revise the plan stays in `plan-delivery`.

## Exit States

End with exactly one result:

1. a compiled execution-ready plan and review handoff;
2. one material decision blocking compilation; or
3. an explicit return to `shape-story` with the contract issue to resolve.
