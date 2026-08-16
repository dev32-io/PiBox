---
name: plan-delivery
description: Use when converting a coherent high-level story into an execution-ready technical delivery plan for user review.
---

# Plan Delivery

Turn a coherent story into a small set of self-contained implementation tickets. Each task should be understandable and executable by one fresh worker without reconstructing its assignment from artifact references.

## Enter Deliberately

Enter only after the user has reviewed the persisted story checkpoint and explicitly asks to plan or continue. A prior end-to-end request does not skip that review gate.

Read the compact work item, then read each intent, specification, design, decision, and `e2e-matrix` child ref with `resource_read`. Treat those resources as the product contract: the approved E2E matrix is binding verification context. Planning normally reads them and writes one unified staged graph of implementation and focused evaluation nodes only. If repository evidence exposes a product-contract problem, discuss it with the user and update only the affected story resource before continuing.

## Plan the Delivery

1. **Map the seams first** — Inspect the repository before naming tickets. Record the relevant module/file responsibilities, current entry points, data/control flow, compatibility constraints, migration needs, and meaningful proof seams in your planning notes. This map is an input to decomposition, not a ticket for reconnaissance. Confirm the work item's immutable `workingBranch` binding and remain on it; delivery planning never creates, switches, or rewrites branches.
2. **Cut tracer bullets and decompose vertical slices** — Cut the smallest coherent, independently useful slices that pass through every layer and focused test their behavior needs. Every completed task must leave a runnable, demonstrable behavior—not merely scaffolding, domain types, storage, API plumbing, or UI components waiting for a later task. In a greenfield repository, combine setup with the first user-visible vertical slice. Use a preparatory task only when no safe vertical slice can keep the branch green, and state the concrete reason. Split work when it contains multiple independently reviewable outcomes, distinct state machines, or separate domains; do not split merely to increase task count. Prefactor-only work is an exception when the seam is required to make the first slice safe, and expand–migrate–contract is an exception when compatibility requires ordered intermediate states.
3. **Write complete tickets for one fresh worker** — Each ticket must be executable in one fresh worker context without reconstructing its assignment from artifact references. Give it one contribution goal, context, included and excluded boundary, and explicit ordered concrete implementation/test steps in `requiredWork` (or the equivalent structured required-work field). State interfaces consumed and produced, constraints, observable acceptance, the proof seam that demonstrates it, checks, and integration expectation. Include relevant requirements directly; `task_clarify` is an escape hatch for a genuine uncertainty, not a substitute for a complete contract.
4. **Arrange delivery for parallelism** — Parallel is the default: put independent implementation and evaluation nodes in the same stage and declare only true blockers in `dependsOn` (a required predecessor/interface, compatibility migration order, or unavoidable shared resource). Do not serialize work for convenience or model strength. Nodes in one stage are the parallel frontier; they must not depend on each other or claim incompatible shared resources; the runtime derives repository versus worktree isolation from the reviewed stage graph.
5. **Route capability after decomposition** — Choose one tier only after boundaries and stages are settled. Use `medium` by default; `medium` is the hard default for managed tasks and dynamic subagents; use `low` only for genuinely mechanical low-risk work. High/max require a substantive justification answering all three questions: why medium is insufficient for this specific bounded task, what irreducible ambiguity or complexity remains, and why further decomposition would be unsafe, incoherent, or destroy the required seam. `max` is exceptional and user-requested, reserved for architecture, security, privacy, irreversible, or unusually high-blast-radius work. Record the justification in the assignment when high/max is selected. Each tier is an ordered list of concrete `provider/model#effort` pairs resolved by the harness.
6. **Plan proof** — Preserve every approved E2E matrix case exactly, map planned work and proof seams to each case, and ensure every binding story criterion is implemented and verified somewhere in the task set. The matrix is verification context, not planner-authored gates: never rewrite, replace, or expand it into final gates. Keep this coverage at the assembled-plan level rather than encoding artifact references into each task. Add focused deterministic, regression, migration, or independent review evaluations only where their risk justifies them; avoid artificial task or evaluation quotas. The runtime owns final whole-branch journey verification and the final branch review; do not create either in the delivery plan.
7. **Write resources** — Use `resource_write` to create or update one implementation or evaluation node at a time; both use `stageId` for explicit stage membership and `dependsOn` for true graph edges. Creation uses `type`, `parent`, and `value`; updates use `ref` and `value`. Do not read a separate schema or resend unchanged intent, specification, or design resources.
8. **Review the durable plan** — Use `resource_list` to inventory the assembled plan and `resource_read` to inspect each complete task. Check coverage, vagueness, consistency, dependency order, parallel safety, and whether every ticket fits one fresh worker context. Correct only the affected resource with `resource_write`.
9. **Submit for review** — Call `workflow_transition` with `submit` only after the durable resources are coherent. Submission is a user review handoff, not execution authorization. A separate planning critique is optional and runs only when the user explicitly requests it; use `subagent_spawn` with `plan-critic` without delaying ordinary plans.

## Resource Examples

The work item's `workingBranch` was established during initial story creation. Do not write branch lifecycle fields during planning.

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
      "Consumes the existing CheckoutCommand input and validation result; produces the created order identifier or typed failure.",
      "Proof seam: the command boundary and focused tests demonstrate both outcomes."
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

Create a risk-warranted focused evaluation node in the same staged graph (not a separate evaluations bucket):

```json
{
  "type": "evaluation",
  "parent": "work-item:checkout",
  "value": {
    "id": "checkout-idempotency-regression",
    "type": "regression",
    "stageId": "verification",
    "dependsOn": ["submit-checkout"],
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
