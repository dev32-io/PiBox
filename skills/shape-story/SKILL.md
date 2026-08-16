---
name: shape-story
description: Use when shaping product discussion into a high-level story, product contract, specification, design boundary, or explicit scope.
---

# Shape Story

Hold a collaborative technical round with the user, then turn the shared understanding into a durable intent, specification, and high-level design. This phase sharpens the domain and explores the design; it is not a serialization step between discussion and planning.

## Enter Deliberately

Enter when the user chooses to make an outcome, scope, specification, or design durable. Agreement with a rough feature outline only starts shaping—it does not approve a story or technical design that has not yet been presented.

Use `resource_list` to look for a matching unfinished story. Read relevant repository behavior, existing intent/spec/design artifacts, `CONTEXT.md`, context maps, and consequential decisions before proposing changes. Continue existing work only when it represents the current unfinished outcome.

## Collaborate Before Writing

Do not create story resources immediately. First work through the technical frontier with the user:

1. **Frame the outcome** — Reflect the problem, actors, desired result, known constraints, and assumptions. Identify what came from the user versus repository evidence or your recommendation.
2. **Sharpen the domain** — Challenge vague, overloaded, or conflicting terms. Propose precise canonical language and distinguish concepts that have different identity, ownership, state, or lifecycle. If repository vocabulary disagrees with the conversation, surface it immediately.
3. **Probe with scenarios** — Invent concrete primary, edge, failure, and recovery scenarios. Use them to expose hidden rules, invalid states, boundaries between concepts, and behavior the user has not decided yet.
4. **Inspect reality** — Cross-reference claims with the code and current interfaces. Follow existing patterns where they serve the outcome; call out contradictions and targeted structural problems that materially affect the design.
5. **Explore approaches** — Present two or three credible approaches when a consequential design choice exists. Lead with your recommendation, explain tradeoffs, and remove unnecessary scope. Do not manufacture alternatives for trivial choices.
6. **Present the contract and design** — Walk through the proposed domain language, behavior and acceptance, then high-level technical design. Scale each section to its complexity and pause after each consequential section so the user can correct it. Revisit earlier sections when a scenario changes the model.

Ask one useful question at a time when possible. Prefer a concrete scenario or a small set of choices over a broad questionnaire. Respond substantively before asking the next question.

## What to Shape

A coherent story captures only durable high-level understanding:

- **Intent** — problem, actors, desired outcome, included and excluded scope, constraints, assumptions, and success signals.
- **Specification** — canonical domain language, required behavior, concrete scenarios, edge cases, and stable observable acceptance criteria.
- **Design** — chosen approach, component and interface boundaries, data/control flow, failure and recovery behavior, compatibility, security/privacy, and verification boundaries where relevant.
- **Decisions** — only choices that are hard to reverse, surprising without context, and the result of a genuine tradeoff.

Do not define implementation tasks, stages, assignments, capability tiers, worktree strategy, or evaluation plans. If the discussion becomes exploratory again, stay in this technical round or return explicitly to `product-discussion`; do not harden tentative ideas.

## Validate, Then Persist

Before writing resources, present a compact story/design checkpoint **and a conservative touched-area E2E matrix**. The matrix must list substantive structured cases with stable IDs, one classification (golden-path, edge, failure, or recovery), journey, setup, actions, expected outcomes, evidence, and safety notes where suitable. This is the last collaborative checkpoint: explicitly discuss and finalize the matrix with the user, including what is deliberately excluded, then ask whether the complete checkpoint represents the user's intent. Prior agreement to “build,” “shape,” or “plan” does not approve this unseen checkpoint.

After the user validates the checkpoint:

1. Create or update the work item with `resource_write`. Initial creation must occur from a clean `develop` checkout; it prepares and binds `feature/<work-item-id>` before writing. For defect work, pass `branchKind: "fix"`; pass `workingBranch` only when an explicit matching feature/fix name is required. Subsequent story mutations stay on that bound branch.
2. Write only the specification, design, conservative touched-area `e2e-matrix`, and rare decision artifacts the story needs. Persist the exact user-approved matrix content; do not summarize or replace its cases.
3. Read each written artifact ref back individually and check for placeholders, contradictions, ambiguous terms, missing scenarios, and disagreement between acceptance and design. A compact work-item read is not a substitute for reading its child artifacts.
4. Correct only the affected resource. Include the persisted e2e-matrix in the story review checkpoint and resource refs.

Use these author-facing shapes; the resource API translates them to canonical storage.

**Story container:**

```json
{
  "type": "work-item",
  "value": {
    "id": "checkout",
    "title": "Reliable checkout",
    "branchKind": "feature",
    "intentSections": {
      "problem": "Customers cannot reliably complete checkout.",
      "desiredOutcome": "A valid checkout consistently produces an order.",
      "scopeIncluded": ["Checkout submission and user-visible failures"],
      "scopeExcluded": ["Payment settlement"],
      "constraints": ["Existing clients remain compatible"],
      "successSignals": ["Specified success and failure scenarios are observable"]
    }
  }
}
```

**Specification artifact:**

```json
{
  "type": "artifact",
  "parent": "work-item:checkout",
  "value": {
    "id": "checkout-behavior",
    "kind": "spec",
    "title": "Checkout behavior",
    "content": {
      "context": "Defines checkout submission from the customer's perspective.",
      "domainLanguage": ["Checkout is the mutable purchase attempt; Order is the accepted result."],
      "actors": ["Customer"],
      "behaviors": ["Valid submission creates exactly one order."],
      "acceptance": ["A valid checkout returns the created order identifier."],
      "scenarios": ["A customer submits a valid checkout once."],
      "edgeCases": ["Repeated submission does not create a duplicate order."],
      "outOfScope": ["Payment settlement"]
    }
  }
}
```

**Design artifact:**

```json
{
  "type": "artifact",
  "parent": "work-item:checkout",
  "value": {
    "id": "checkout-design",
    "kind": "design",
    "title": "Checkout design",
    "content": {
      "goal": "Keep checkout behavior isolated behind one command boundary.",
      "approach": ["Route submission through CheckoutCommand and return its typed result."],
      "components": ["Checkout form calls CheckoutCommand; repository persists the accepted Order."],
      "flow": ["Validate checkout, create order, persist it, return identifier."],
      "failureAndRecovery": ["Validation failures return without persistence."],
      "verification": ["Command tests prove success, rejection, and duplicate-submission behavior."],
      "alternatives": ["Direct component persistence was rejected because it couples UI and storage."]
    }
  }
}
```

**Approved E2E matrix artifact:**

```json
{
  "type": "artifact",
  "parent": "work-item:checkout",
  "value": {
    "id": "checkout-e2e",
    "kind": "e2e-matrix",
    "title": "Checkout E2E matrix",
    "content": {
      "scope": ["Touched checkout submission and visible rejection paths"],
      "cases": [{
        "id": "E2E-001",
        "classification": "golden-path",
        "journey": "Customer completes checkout",
        "setup": ["Use a disposable customer and valid cart"],
        "actions": ["Open checkout", "Submit the valid cart"],
        "expectedOutcomes": ["One order is created", "Confirmation shows its identifier"],
        "evidence": ["Visible confirmation and persisted disposable order"],
        "safety": ["Remove disposable state; retain no customer secrets"]
      }],
      "safety": ["Never exercise live settlement"]
    }
  }
}
```

## Story Review Gate

After persistence, present the story checkpoint and resource refs to the user, then stop. Always wait for the user to review or explicitly ask to proceed to delivery planning—even when they originally requested an end-to-end plan. Never load or invoke `plan-delivery` in the same turn that finishes shaping.

A later explicit request such as “the story looks right, plan it” enters `plan-delivery`. Requested changes remain in `shape-story`.

## Deliverable

End with exactly one result:

1. one focused domain, behavior, or design question;
2. a proposed story/design section awaiting user correction or validation;
3. a persisted coherent story checkpoint awaiting explicit user review; or
4. an explicit return to `product-discussion` with the reopened frontier.
