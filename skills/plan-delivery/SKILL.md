---
name: plan-delivery
description: Use when converting a coherent high-level story into an execution-ready technical delivery plan for user review.
---

# Plan Delivery

Turn a coherent story into a small set of self-contained implementation tickets. Each task should be understandable and executable by one fresh worker without reconstructing its assignment from artifact references.

## Enter Deliberately

Enter only after the user has reviewed the persisted story checkpoint and explicitly asks to plan or continue. A prior end-to-end request does not skip that review gate.

Read the compact work item, then read each specification, design, decision, and `e2e-matrix` child ref with `resource_read`. The approved E2E matrix is binding verification context. If the work item declares amendment metadata, also read its completed baseline chain as immutable context; write only incremental amendment artifacts, tasks, and stages under the amendment ref, and treat every applicable approved matrix across that chain as binding. Planning writes implementation tasks and ordered execution stages. If repository evidence exposes a product-contract problem, discuss it with the user and update only the affected editable story resource before continuing.

## Execution Model

Plans use ordered stages. Every new stage must explicitly set `mode` to `sequential` or `concurrent`; omitted mode is retained only for legacy plans (singleton stages resolve sequentially, multi-task stages concurrently). Sequential tasks run serially in declared order on the canonical working branch and see prior task commits. Concurrent independent tasks run in per-task worktrees from one base and cross one merge barrier. After a stage's checks, the runtime runs its review/fix loop unless the planner explicitly skips that low-risk review. After assembly it reviews the exact execution-start-to-current branch diff as one integrated feature, then runs final E2E. The planner authors tasks, stages, checks, and explicit review policy, but never evaluations.

## Plan the Delivery

1. **Map the seams first** — Inspect the repository before naming tickets. Record the relevant module/file responsibilities, current entry points, data/control flow, compatibility constraints, migration needs, and meaningful proof seams in your planning notes. This map is an input to decomposition, not a ticket for reconnaissance. Confirm the work item's immutable `workingBranch` binding and remain on it; delivery planning never creates, switches, or rewrites branches.
2. **Aggressively decompose implementation changes** — Optimize task size for fresh medium/smaller workers, not for an abstract vertical slice. Split by default:
   - every conjunction or independently reviewable outcome;
   - data, model, schema, migration, policy, integration, and platform changes;
   - interfaces and data contracts, routing, and policy rules;
   - each CRUD operation (create, read, update, delete);
   - each algorithm case or state-machine branch (for example, recurrence cases);
   - visibility/authorization rules and write gates.
   Keep tests and focused checks inside the implementation ticket they constrain. Never create proof-only, test-only, review-only, or verification-only tasks. A task may be compiling intermediate work inside a sequential stage; stage coherence and ordered integration replace per-task user-visible completeness. Combine adjacent changes only when separating them would break compilation or make one commit meaningless. The first greenfield task may combine setup with the smallest useful behavior when that is the only meaningful seam; prefactor-only and expand–migrate–contract tasks remain exceptions when a safe ordered intermediate state is required.

   **Compressed/decompressed example:** “Add a resource with persistence, API, CRUD, and permissions” is too broad. Split it into contracts, schema/migration, store boundary, create, read/list, update, delete, and authorization-policy tickets. Each owns its implementation and focused tests; combine only where separation would break compilation or produce a meaningless commit.
3. **Write complete tickets for one fresh worker** — Each ticket must be executable in one fresh worker context without reconstructing its assignment from artifact references. Give it one contribution goal, context, included and excluded boundary, and explicit ordered concrete implementation/test steps in `requiredWork` (or the equivalent structured required-work field). State interfaces consumed and produced, constraints, observable acceptance, the proof seam that demonstrates it, checks, and integration expectation. Include relevant requirements directly.
4. **Arrange delivery for parallelism** — Parallel is the default: put independent tasks in the same concurrent stage and declare only true blockers in `dependsOn` (a required predecessor/interface, compatibility migration order, or unavoidable shared resource). Do not serialize work for convenience or model strength. Ordered tasks may instead share a sequential stage when prior compiling commits are their intended interfaces; concurrent tasks must not depend on each other or claim incompatible shared resources.
5. **Route capability after decomposition** — Choose one tier only after boundaries and stages are settled. Use `medium` by default; `medium` is the hard default for managed tasks and dynamic subagents; use `low` only for genuinely mechanical low-risk work. High/max require a substantive justification answering all three questions: why medium is insufficient for this specific bounded task, what irreducible ambiguity or complexity remains, and why further decomposition would be unsafe, incoherent, or destroy the required seam. `max` is exceptional and user-requested, reserved for architecture, security, privacy, irreversible, or unusually high-blast-radius work. Record the justification in the assignment when high/max is selected. Each tier is an ordered list of concrete `provider/model#effort` pairs resolved by the harness.
6. **Plan proof and review risk** — Reconcile the approved E2E matrix against repository reality and the mapped seams. Preserve every approved case exactly; map planned work and proof to each case and every binding criterion. Surface missing actor, surface, rule, transition, or risk coverage and product contradictions for user review instead of editing the matrix. Put focused deterministic, regression, or migration commands in task or stage `checks`. Make an explicit stage-review decision:
   - use `review.mode: required` when the stage crosses security/privacy/identity, persistence/migration/data-integrity, concurrency/lifecycle, public protocol/compatibility, service/platform, irreversible, or weakly observable boundaries;
   - use `review.mode: skip` only when the stage is local, reversible, mechanically specified, and completely covered by direct deterministic checks, and give a substantive rationale;
   - choose `medium` for ordinary required review; choose `high` only when multiple material risk dimensions remain after decomposition, with substantive focus and rationale.
   Omission remains legacy required/medium behavior and is not a planner opt-out. Review necessity follows risk, observability, reversibility, and boundary crossings—not complexity alone. The runtime performs whole-branch review before final E2E; the planner creates neither evaluation.
7. **Write resources** — Use `resource_write` to create or update tasks and stages. Planning is editable source: individual writes may temporarily leave dependencies, membership, or ordering incomplete, and returned topology diagnostics are advisory until submission compiles the complete plan. Give each task its intended `stageId` when known so stage order emerges as tasks are written; a stage's `tasks` array remains membership authority and also declares checks and optional review policy. Creation uses `type`, `parent`, and `value`; updates use `ref` and `value`. Do not read a separate schema or resend unchanged story resources.
8. **Review the durable plan** — Use `resource_list` to inventory the assembled plan and `resource_read` to inspect each complete task. Check coverage, vagueness, consistency, dependency order, parallel safety, and whether every ticket fits one fresh worker context. Correct only the affected resource with `resource_write`.
9. **Submit for review** — After the resources are coherent, call `workflow_transition` with the work-item `ref`, `action: "submit"`, and a concise `reason`. Submission is the compilation boundary: it validates the complete task/stage topology, reports every remaining issue together, and leaves invalid drafts editable. Successful submission is a user review handoff, not execution authorization. A planning critique is optional and runs only when the user requests it; use `subagent_spawn` with `plan-critic` without delaying ordinary plans.

## Resource Examples

Create one self-contained task. Use this shape as a guide and omit optional fields that add no information:

```json
{
  "type": "task",
  "parent": "work-item:checkout",
  "value": {
    "id": "submit-checkout",
    "title": "Submit checkout",
    "goal": "Customers can submit a valid checkout and receive the resulting order.",
    "context": [
      "The existing checkout command owns validation and order creation."
    ],
    "included": [
      "Connect checkout submission through the existing command boundary",
      "Return the created order or the command's typed validation failure",
      "Add focused tests for successful and rejected submission"
    ],
    "requiredWork": [
      "1. Trace the existing checkout command and preserve its input/result interface.",
      "2. Connect valid submission to order creation and return the created identifier.",
      "3. Preserve typed validation failure without creating an order.",
      "4. Add and run focused success and rejection tests."
    ],
    "excluded": [
      "Payment settlement and receipt delivery"
    ],
    "interfaces": [
      "Consumes the existing CheckoutCommand input and validation result; produces the created order identifier or typed failure."
    ],
    "acceptance": [
      "A valid checkout creates one order and returns its identifier",
      "Invalid input returns the existing validation failure without creating an order"
    ],
    "proof": [
      "Focused command tests cover successful and rejected submission"
    ],
    "checks": [
      "npm test -- checkout-command"
    ],
    "dependsOn": [],
    "stageId": "checkout-delivery",
    "assignment": {
      "tier": "medium"
    }
  }
}
```

Create the stage and put focused proof at that boundary:

```json
{
  "type": "stage",
  "parent": "work-item:checkout",
  "value": {
    "id": "checkout-delivery",
    "mode": "sequential",
    "tasks": ["submit-checkout"],
    "checks": ["npm test -- checkout-command"],
    "review": {
      "mode": "required",
      "tier": "medium",
      "focus": ["Checkout submission and typed validation failures"]
    }
  }
}
```

The harness supplies lifecycle defaults, generated titles where possible, assignment defaults, singleton stages, execution isolation, and runtime state. A worker receives the complete rendered task contract in persistent context. `task_clarify` remains available when a concrete uncertainty genuinely requires additional intent, specification, design, decision, or neighboring-task context; it is an escape hatch, not a substitute for a complete ticket.

## Readiness Check

Before submission, verify:

- every task has one narrow implementation contribution and its embedded proof, rather than an arbitrary horizontal bundle;
- sequential stages may contain compiling intermediate tasks, while stage ordering preserves a coherent assembled behavior;
- its context and acceptance are self-contained and contain no `artifact#AC-NNN` instructions;
- included, excluded, and interface boundaries prevent accidental scope growth;
- dependencies point only to tasks in earlier stages;
- parallel tasks have compatible resource claims;
- task and stage checks provide the cheapest meaningful focused proof;
- every stage explicitly requires review or gives a substantive deterministic-proof rationale for skipping it;
- all binding story behavior has an owner and verification path;
- no product decision is hidden in a task assumption;
- no task relies on model strength or `task_clarify` to compensate for a vague contract.

## Review Handoff

Present the work-item ID, technical approach, contribution stages, parallelism, capability choices, verification, and residual risks. The user can say “start the workflow” or otherwise explicitly request execution; that clear request is the sole execution gate. No separate approval command is required, and planning alone never starts execution.

## Exit States

End with exactly one result:

1. a submitted execution-ready plan and review handoff;
2. one material decision blocking submission; or
3. an explicit return to `shape-story` with the contract issue that must be resolved.
