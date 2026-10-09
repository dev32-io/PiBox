---
name: shape-story
description: Use when shaping product discussion into a high-level story, product contract, specification, design boundary, or explicit scope.
---

# Shape Story

Hold a collaborative technical round with the user, then persist one reviewable story. This phase sharpens the product contract and high-level design; it is not delivery planning.

## Enter

Enter when the user chooses to make an outcome, scope, specification, or design durable. Agreement with a rough feature outline starts shaping; it does not approve a story that has not yet been presented.

Check for a matching unfinished story and inspect it if one exists; continue it only when it represents the current outcome. Read the relevant repository behavior, project context, and consequential prior decisions before proposing changes.

## Collaborate Before Writing

Write nothing until the checkpoint below is validated. Before the checkpoint, make each of these settled or listed as an open gap:

- problem, actors, desired result, included and excluded scope, constraints, assumptions, and success signals;
- vocabulary: vague or conflicting terms resolved and reconciled with repository terms;
- primary, edge, failure, and recovery scenarios, and the rules or invalid states they expose;
- contradictions between the conversation and current code or interfaces;
- the recommended approach and its tradeoffs when a consequential choice exists.

Walk the user through behavior, boundaries, flow, failure and recovery, and verification implications, pausing for correction at consequential points. Answer with substance before asking, and ask one question at a time.

## Author the Story

`story_write` takes the specification sections **Outcome**, **Scope**, **Behavior**, and **Acceptance**, and the design sections **Approach**, **Boundaries and Flow**, and **Failure and Verification**; its parameter descriptions define each. Section bodies are Markdown-rich, proportional, and non-repetitive. The renderer owns level-two (`##`) headings; inside a field use bold labels, lists, tables, or level-three (`###`) headings only.

Keep consequential decisions inside the relevant section. Do not add artifact catalogs, taxonomy, criterion IDs, or block IDs. Do not define tasks, stages, assignments, worktree strategy, evaluations, reports, or handoffs.

## Author the E2E Matrix

The matrix has a global scope (`e2eScope`), optional exclusions (`e2eExclusions`) for deliberately unexercised surfaces or risks, and independent stable `E2E-NNN` cases, each with a descriptive title and only **Exercise**, **Oracle**, and **Proof**. Proof uses internal evidence only for a named hidden invariant.

Derive cases from real actors, surfaces, rules, transitions, and material risks, not implementation structure. Use the smallest non-duplicate set.

## Validate, Then Persist

Before writing, present a compact checkpoint with the complete proposed story sections and E2E matrix, deliberate exclusions, and unresolved coverage gaps. Ask explicitly whether it represents the user's intent. Prior agreement to "build," "shape," or "plan" does not approve an unseen checkpoint.

Writers require a valid Git `HEAD`, a clean worktree, and `develop` or the matching feature/fix branch; they create the target branch and commit. Do not repair Git setup manually without user authority.

After the user validates the checkpoint:

1. Create the story with `story_write` and each case with `e2e_write`.
2. Read them back and check structure, placeholders, contradictions, ambiguous terms, missing scenarios, and disagreement between behavior, design, and journeys.
3. Update only the affected field or case, unless an error requires replacing a complete malformed field group.
4. Call near-zero-argument `workflow_compile`. It mutates nothing and authorizes neither planning nor execution. Fix the named resources and recompile.

Keep content compact, for example `E2E-001`: Exercise "Submit a disposable valid cart through checkout." Oracle "One confirmation identifies one created order." Proof "Capture the confirmation and query the disposable order, then remove it."

## Story Review Gate

After the story is first persisted, present the complete rendered story and E2E checkpoint with its story identity, then stop. Always wait for the user to review it or explicitly ask to proceed to delivery planning, even when the original request asked for an end-to-end plan. Never load or invoke `plan-delivery` in the same turn that first persists the shaped story.

A later explicit request such as "the story looks right, plan it" enters `plan-delivery`. Requested story changes stay in `shape-story`.

## Exit States

End with exactly one result:

1. one focused domain, behavior, or design question;
2. a proposed story section or E2E matrix awaiting correction or validation;
3. a persisted coherent story awaiting explicit user review; or
4. an explicit return to `product-discussion` with the reopened frontier.
