---
name: plan-delivery
description: Use when converting a coherent high-level story into an execution-ready technical delivery plan for user review.
---

# Plan Delivery

Turn a coherent story into a small set of self-contained implementation tickets. Each task should be understandable and executable by one fresh worker without reconstructing its assignment from artifact references.

## Enter Deliberately

Enter only after the user has reviewed the persisted story checkpoint and explicitly asks to plan or continue. A prior end-to-end request does not skip that review gate.

Read the compact work item, then read each intent, specification, design, and decision child ref with `resource_read`. Treat those resources as the product contract: planning normally reads them and writes tasks, stages, and evaluations only. If repository evidence exposes a product-contract problem, discuss it with the user and update only the affected story resource before continuing.

## Plan the Delivery

1. **Locate the seams** — Inspect only enough repository structure and behavior to identify implementation boundaries, compatibility constraints, migration needs, and meaningful verification. Set the work item's delivery contract with `resource_write`: `feature` for capabilities/refactors or `fix` for defects, and `create` from `develop` or `continue` on the explicitly current feature/fix branch.
2. **Cut tracer bullets** — Define the smallest independently useful contributions that pass through every layer and focused test their behavior needs. Every completed task must leave a runnable, demonstrable behavior—not merely scaffolding, domain types, storage, API plumbing, or UI components waiting for a later task. In a greenfield repository, combine setup with the first user-visible vertical slice. Use a preparatory task only when no safe vertical slice can keep the branch green, and state why.
3. **Write complete tickets** — Give each task its outcome, necessary context, included and excluded boundary, required work, interfaces, constraints, observable acceptance, proof, checks, and integration expectation. Include the relevant requirement directly; do not make the worker dereference specification or design IDs to understand the assignment.
4. **Arrange delivery** — Declare blockers and stages only where sequencing matters. Tasks in one stage are the parallel frontier and must not depend on each other or claim the same shared resource. The runtime derives repository versus worktree isolation from the reviewed stage graph.
5. **Route capability** — Choose one tier after the task boundary is settled. Use `medium` by default; use `low` for mechanical work, `high` for difficult integration or state/control flow, and `max` only for architecture, security, privacy, irreversible, or unusually high-blast-radius work. Each tier is an ordered list of concrete `provider/model#effort` pairs resolved by the harness.
6. **Plan proof** — Ensure every binding story criterion is implemented and verified somewhere in the task set. Keep this coverage at the assembled-plan level rather than encoding artifact references into each task. Add focused deterministic, regression, migration, or independent review evaluations only where their risk justifies them. The runtime owns final whole-branch journey verification and the final branch review; do not create either in the delivery plan.
7. **Write resources** — Use `resource_write` to create or update one task or evaluation at a time; task `stageId` records stage membership. Creation uses `type`, `parent`, and `value`; updates use `ref` and `value`. Do not read a separate schema or resend unchanged intent, specification, or design resources.
8. **Review the durable plan** — Use `resource_list` to inventory the assembled plan and `resource_read` to inspect each complete task. Check coverage, vagueness, consistency, dependency order, parallel safety, and whether every ticket fits one fresh worker context. Correct only the affected resource with `resource_write`.
9. **Submit for review** — Call `workflow_transition` with `submit` only after the durable resources are coherent. Submission is a user review handoff, not execution authorization. A separate planning critique is optional and runs only when the user explicitly requests it; use `subagent_spawn` with `plan-critic` without delaying ordinary plans.

## Resource Examples

Set delivery without rewriting the story:

```json
{
  "ref": "work-item:checkout",
  "value": {
    "delivery": {
      "branchType": "feature",
      "branchMode": "create"
    }
  }
}
```

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
    "excluded": [
      "Payment settlement and receipt delivery"
    ],
    "interfaces": [
      "Preserve the existing CheckoutCommand input and result types"
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
    "assignment": {
      "tier": "medium"
    }
  }
}
```

Create a risk-warranted focused evaluation with the same ticket-like style:

```json
{
  "type": "evaluation",
  "parent": "work-item:checkout",
  "value": {
    "id": "checkout-idempotency-regression",
    "kind": "regression",
    "title": "Verify checkout idempotency",
    "context": ["Run after checkout submission is integrated."],
    "criteria": ["Repeated submission creates exactly one order."],
    "checks": ["npm test -- checkout-idempotency"]
  }
}
```

The harness supplies lifecycle defaults, generated titles where possible, assignment defaults, singleton stages, execution isolation, and runtime state. A worker receives the complete rendered task contract in persistent context. `task_clarify` remains available when a concrete uncertainty genuinely requires additional intent, specification, design, decision, or neighboring-task context; it is an escape hatch, not a substitute for a complete ticket.

## Readiness Check

Before submission, verify:

- every task has one independently useful, runnable contribution goal rather than a horizontal layer;
- the first greenfield task combines setup with visible behavior and its proof;
- its context and acceptance are self-contained and contain no `artifact#AC-NNN` instructions;
- included, excluded, and interface boundaries prevent accidental scope growth;
- dependencies point only to earlier stages;
- parallel tasks have compatible resource claims;
- checks and evaluations provide the cheapest meaningful proof;
- all binding story behavior has an owner and verification path;
- no product decision is hidden in a task assumption;
- no task relies on model strength or `task_clarify` to compensate for a vague contract.

## Review Handoff

Present the work-item ID, technical approach, contribution stages, parallelism, capability choices, verification, and residual risks. The user can say “start the workflow” or otherwise explicitly request execution; that clear request is the sole execution gate. No separate approval command is required, and planning alone never starts execution.

## Deliverable

End with exactly one result:

1. a submitted execution-ready plan and review handoff;
2. one material decision blocking submission; or
3. an explicit return to `shape-story` with the contract issue that must be resolved.
