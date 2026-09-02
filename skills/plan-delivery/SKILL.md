---
name: plan-delivery
description: Use when converting a coherent high-level story into an execution-ready technical delivery plan for user review.
---

# Plan Delivery

Turn a reviewed story into self-contained fresh-agent assignments arranged in ordered stages. Story review, plan review, and execution start remain separate authority boundaries.

## Enter Deliberately

Enter only after the user has reviewed the first persisted story and explicitly asks to plan or continue. A prior end-to-end request does not skip that review gate.

Read the complete rendered story and E2E matrix. Treat their Markdown as binding context. If repository evidence exposes a product-contract problem, return to `shape-story` and update only the affected story section or E2E case before continuing.

## Execution Model

A plan is an ordered stage train. Every stage declares `mode: sequential` or `mode: concurrent`.

- A **concurrent stage** fans independent tasks into per-task worktrees from one pinned base, then integrates them through one barrier. Its tasks cannot depend on one another or claim incompatible shared resources.
- A **sequential stage** runs tasks serially in one isolated stage workspace, so each fresh agent sees prior task commits before one integration barrier.

Within a stage, the runtime owns implementation, task checks and repairs, deterministic integration, stage checks, and any planned review/fix loop. Later stages wait for the current stage to settle. After all stages, the runtime performs whole-branch review and final E2E from the approved matrix.

Tasks are fresh-agent boundaries, not implementation steps. A multi-task sequential stage is an exceptional baton pass. The planner authors tasks, stages, deterministic checks, and optional stage review policy—never evaluations, reports, handoffs, repair tasks, or retry limits.

## Plan the Delivery

1. **Map the seams first** — Inspect repository responsibilities, entry points, data/control flow, compatibility constraints, migrations, and proof seams. Confirm the story's canonical working branch and do not switch branches during planning.
2. **Choose fresh-agent boundaries** — Keep coupled discovery, invariants, implementation, and focused proof together. Split only at coherent independent seams, durable predecessor outputs, or unrelated problem domains. Never create proof-only, review-only, repair-only, or verification-only tasks.
3. **Write minimal complete tasks** — Each task has metadata plus Markdown-rich `description`, `scope`, and `delivery`, and deterministic `checks`. The complete assignment must fit one fresh agent without dereferencing story artifacts or narrative block references:
   - `description` explains the contribution and necessary technical context;
   - `scope` states included ownership, exclusions, dependencies/interfaces, and integration boundary;
   - `delivery` states required implementation, observable result, focused proof, and expected repository state;
   - `checks` lists executable deterministic commands owned by the harness.
4. **Arrange ordered stages** — Put every independent, resource-compatible task that can start from one base in the same concurrent stage. Add a later stage only for a true dependency on integrated output. Use a multi-task sequential stage only when each task warrants a fresh context but must consume prior commits or cannot safely run concurrently.
5. **Route capability after decomposition** — Use `medium` by default and `low` only for mechanical low-risk work. `local` requires current explicit user permission recorded in `rationale`. High/max require `tierJustification` explaining why medium is insufficient and further decomposition would damage the seam.
6. **Plan deterministic proof and review risk** — Reconcile task/stage checks and final E2E with the complete story. Require stage review for material security/privacy, identity, persistence/data-integrity, concurrency/lifecycle, public compatibility, platform, irreversible, or weakly observable boundaries. Skip only when direct deterministic checks completely cover a local, reversible boundary. `.pi/harness.yaml` `limits.repairRounds` remains the sole retry-limit authority.

Keep the prose fields proportional to complexity. Use subheadings, lists, or code references when they make a fresh-agent assignment clearer, but do not inflate a bounded task or repeat the same requirements in every field.

## Write Flat Draft Resources

- Work on the story's clean bound branch; flat writers own harness commits. Create a task without `ref` with `story`, `id`, `title`, `description`, `scope`, and `delivery`; create a stage with `story`, `id`, and `mode`. Membership may be empty only while drafting.
- Update by canonical `ref` and send only changed fields. `dependsOn`, `checks`, and stage `tasks` replace their complete arrays, so resend every retained entry. A supplied `id` or `story` must match the ref.
- Dangling dependencies and incomplete membership are valid drafts. `workflow_compile` requires at least one non-empty stage, assigns every task exactly once, and validates dependency order, routes, checks, and review policy.
- `reviewMode` persists `required` or `skip`; `none` removes the policy. `reviewFocus` requires a review mode.

Example task: description “Connect checkout through the existing command boundary”; scope “Own the adapter and focused tests; exclude settlement”; delivery “Create one order for valid input, preserve typed rejection, and prove success, rejection, and duplicate submission”; check `npm test -- checkout-command`.

Inspect completed resources and correct only the affected one. Do not write raw YAML or use generic/nested authoring tools.

## Readiness Check

Before compiling, verify:

- every task is a complete, bounded fresh-agent context without narrative pointers;
- every task belongs to one stage, dependencies resolve, and concurrent peers are independent;
- executable checks sit at the cheapest boundary and review policy matches risk; and
- all story behavior has an owner and proof path, with no authored evaluations, handoffs, repair work, or retry counts.

## Compile for Plan Review

Call near-zero-argument `workflow_compile` without resending authored content. It aggregates deterministic findings and mutates nothing. Fix named resources and recompile. Success yields the content for plan review; it creates no handoff artifact and does not start execution.

## Plan Review and Start Authority

Present the story identity, technical approach, ordered stages, concurrency, capability choices, checks, review decisions, final E2E coverage, and residual risks. Then wait for explicit plan review. Planning and successful compilation do not inherit authority from story approval and do not authorize execution.

Only a later explicit request such as “start the workflow” enters `workflow-run` and authorizes the separate start gate. A request to revise the plan remains in `plan-delivery`.

## Exit States

End with exactly one result:

1. a compiled execution-ready plan and review handoff;
2. one material decision blocking compilation; or
3. an explicit return to `shape-story` with the contract issue to resolve.
