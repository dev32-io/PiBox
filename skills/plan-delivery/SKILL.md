---
name: plan-delivery
description: Use when converting a coherent high-level story into an execution-ready technical delivery plan for user review.
---

# Plan Delivery

Turn a coherent story into self-contained fresh-agent assignments arranged for safe parallel execution. Each task should be understandable and executable by one fresh agent without reconstructing its assignment from artifact references.

## Enter Deliberately

Enter only after the user has reviewed the persisted story checkpoint and explicitly asks to plan or continue. A prior end-to-end request does not skip that review gate.

Read the compact work item, then read each specification, design, decision, and `e2e-matrix` child ref with `resource_read`. The approved E2E matrix is binding verification context. If the work item declares amendment metadata, also read its completed baseline chain as immutable context; write only incremental amendment artifacts, tasks, and stages under the amendment ref, and treat every applicable approved matrix across that chain as binding. Planning writes implementation tasks and ordered execution stages. If repository evidence exposes a product-contract problem, discuss it with the user and update only the affected editable story resource before continuing.

## Execution Model

Tasks are fresh-agent boundaries; stages schedule those tasks; a multi-task sequential stage is an exceptional agent baton pass, not a way to encode implementation steps. A task may contain multiple ordered implementation steps and owns the focused tests and checks that prove its contribution.

Plans execute through ordered stages, and a later stage does not begin until the current stage has integrated and passed its checks and any required review/fix loop. Every stage explicitly sets `mode` to `sequential` or `concurrent`.

- A **concurrent stage** fans independent tasks into per-task worktrees from one common base, then merges them through one barrier. Its tasks cannot depend on each other or claim incompatible shared resources.
- A **sequential stage** runs tasks serially on the canonical working branch, so each fresh agent sees prior task commits.

Each stage is also a potential review boundary, so create stages for real integration gates rather than implementation chronology. After all stages, the runtime reviews the exact execution-start-to-current branch diff as one integrated feature, then runs final E2E. The planner authors tasks, stages, checks, and explicit review policy, but never evaluations.

## Plan the Delivery

1. **Map the seams first** — Inspect the repository before naming tickets. Record the relevant module/file responsibilities, current entry points, data/control flow, compatibility constraints, migration needs, and meaningful proof seams in your planning notes. This map is an input to decomposition, not a ticket for reconnaissance. Confirm the work item's immutable `workingBranch` binding and remain on it; delivery planning never creates, switches, or rewrites branches.
2. **Plan fresh-agent boundaries** — Plan tasks around agent boundaries, not implementation-step boundaries. Keep work together when one agent benefits from retaining the same discovery, reasoning, invariants, source context, or implementation-and-test feedback loop. Split substantial, focused assignments when they are independent and can run concurrently, or when a successor needs only its predecessor's durable output rather than the reasoning that produced it. Split an oversized task at a coherent seam when one agent could not hold its relevant invariants, implement it, and verify it without changing to an unrelated problem domain. Keep proof inside the implementation task it constrains, and never create proof-only, review-only, or verification-only tasks.
3. **Write complete tickets for one fresh agent** — Each ticket must be executable in one fresh-agent context without reconstructing its assignment from artifact references. Give it one contribution goal, context, included and excluded boundary, and explicit ordered concrete implementation/test steps in `requiredWork` (or the equivalent structured required-work field). State interfaces consumed and produced, constraints, observable acceptance, the proof seam that demonstrates it, checks, and integration expectation. Include relevant requirements directly.
4. **Arrange task stages** — After task boundaries are settled, put every independent, resource-compatible task that can start from one base into the same concurrent stage. Add a later stage only when its tasks require integrated output from an earlier stage. Use a multi-task sequential stage only when each task independently warrants a fresh agent but must consume prior task commits or cannot safely run concurrently. Declare only true blockers in `dependsOn`, and never place dependent or resource-incompatible tasks in a concurrent stage.
5. **Route capability after decomposition** — Choose one tier only after boundaries and stages are settled. Use `medium` by default; `medium` is the hard default for managed tasks and dynamic subagents; use `low` only for genuinely mechanical low-risk work. `local` is a permission-gated provider-isolated route: never select or propose it merely for cost, availability, privacy assumptions, or model preference. Use `local` only after the user explicitly requests or approves local execution in the current planning conversation, and record that permission in the task assignment rationale; if permission is absent or ambiguous, ask before writing any local-tier task. High/max require a substantive justification answering all three questions: why medium is insufficient for this specific bounded task, what irreducible ambiguity or complexity remains, and why further decomposition would be unsafe, incoherent, or destroy the required seam. `max` is exceptional and user-requested, reserved for architecture, security, privacy, irreversible, or unusually high-blast-radius work. Record the justification in the assignment when high/max is selected. Each tier is an ordered list of concrete `provider/model#effort` pairs resolved by the harness.
6. **Plan proof and review risk** — Reconcile the approved E2E matrix against repository reality and the mapped seams. Preserve every approved case exactly; map planned work and proof to each case and every binding criterion. Surface missing user role, surface, rule, transition, or risk coverage and product contradictions for user review instead of editing the matrix. Put focused deterministic, regression, or migration commands in task or stage `checks`. Make an explicit stage-review decision:
   - use `review.mode: required` when the stage crosses security/privacy/identity, persistence/migration/data-integrity, concurrency/lifecycle, public protocol/compatibility, service/platform, irreversible, or weakly observable boundaries;
   - use `review.mode: skip` only when the stage is local, reversible, mechanically specified, and completely covered by direct deterministic checks, and give a substantive rationale;
   - choose `medium` for ordinary required review; choose `high` only when multiple material risk dimensions remain after decomposition, with substantive focus and rationale.
   Omission remains legacy required/medium behavior and is not a planner opt-out. Review necessity follows risk, observability, reversibility, and boundary crossings—not complexity alone. The runtime performs whole-branch review before final E2E; the planner creates neither evaluation.
7. **Write resources** — Use `resource_write` to create or update tasks and stages. Planning is editable source: individual writes may temporarily leave dependencies, membership, or ordering incomplete, and returned topology diagnostics are advisory until submission compiles the complete plan. Give each task its intended `stageId` when known so stage order emerges as tasks are written; a stage's `tasks` array remains membership authority and also declares checks and optional review policy. Creation uses `type`, `parent`, and `value`; updates use `ref` and `value`. Do not read a separate schema or resend unchanged story resources.
8. **Review the durable plan** — Use `resource_list` to inventory the assembled plan and `resource_read` to inspect each complete task. Check coverage, vagueness, consistency, dependency order, parallel safety, and whether every ticket fits one fresh-agent context. Correct only the affected resource with `resource_write`.
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

The harness supplies lifecycle defaults, generated titles where possible, assignment defaults, singleton stages, execution isolation, and runtime state. An agent receives the complete rendered task contract in persistent context. `task_clarify` remains available when a concrete uncertainty genuinely requires additional intent, specification, design, decision, or neighboring-task context; it is an escape hatch, not a substitute for a complete ticket.

## Readiness Check

Before submission, verify:

- tasks are coherent fresh-agent boundaries: coupled work stays together, unrelated problem domains stay apart, and each task fits one agent's implementation-and-verification context;
- every task is self-contained, scope-bounded, owns its proof, and does not rely on artifact pointers, model strength, or `task_clarify` to repair a vague contract;
- after task boundaries are settled, concurrent stages contain every independent task with compatible resource claims; dependencies appear only in earlier stages or earlier in the same justified sequential baton pass;
- checks provide the cheapest meaningful proof, broad checks stay at integration boundaries unless specifically needed, and every stage has an explicit risk-based review policy;
- all binding behavior has an owner and verification path, with no hidden product decisions.

## Review Handoff

Present the work-item ID, technical approach, contribution stages, parallelism, capability choices, verification, and residual risks. The user can say “start the workflow” or otherwise explicitly request execution; that clear request is the sole execution gate. No separate approval command is required, and planning alone never starts execution.

## Exit States

End with exactly one result:

1. a submitted execution-ready plan and review handoff;
2. one material decision blocking submission; or
3. an explicit return to `shape-story` with the contract issue that must be resolved.
