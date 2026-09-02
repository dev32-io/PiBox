---
name: shape-story
description: Use when shaping product discussion into a high-level story, product contract, specification, design boundary, or explicit scope.
---

# Shape Story

Hold a collaborative technical round with the user, then persist one reviewable story. This phase sharpens the product contract and high-level design; it is not delivery planning.

## Enter Deliberately

Enter when the user chooses to make an outcome, scope, specification, or design durable. Agreement with a rough feature outline starts shaping—it does not approve a story that has not yet been presented.

Look for a matching unfinished story and inspect it when one exists. Read relevant repository behavior, project context, and consequential prior decisions before proposing changes. Continue existing work only when it represents the current unfinished outcome.

## Collaborate Before Writing

Do not create story resources immediately. First work through the technical frontier with the user:

1. **Frame the outcome** — Reflect the problem, actors, desired result, included and excluded scope, constraints, assumptions, and success signals.
2. **Sharpen the domain** — Challenge vague or conflicting terms and reconcile the conversation with repository vocabulary.
3. **Probe with scenarios** — Use concrete primary, edge, failure, and recovery scenarios to expose hidden rules and invalid states.
4. **Inspect reality** — Cross-reference claims with current code and interfaces; surface consequential contradictions.
5. **Explore approaches** — Lead with a recommendation and real tradeoffs when a consequential choice exists.
6. **Present the contract and design** — Walk through behavior, boundaries, flow, failure/recovery, and verification implications. Pause for correction at consequential points.

Ask one useful question at a time when possible. Respond substantively before asking the next question.

## Author the Story

`story_write` accepts the minimum required structured authoring inputs and renders them as free-form Markdown. Every story has these sections:

### Specification

- **Outcome** — the durable desired result, actors, context, constraints, and success signals needed to understand it.
- **Scope** — included and excluded product behavior and any material assumptions.
- **Behavior** — canonical language, rules, transitions, scenarios, and edge or recovery behavior.
- **Acceptance** — stable observable conditions that establish the outcome.

### Design

- **Approach** — the chosen high-level technical direction and consequential rationale.
- **Boundaries and Flow** — ownership, interfaces, data/control flow, and relevant compatibility or security/privacy boundaries.
- **Failure and Verification** — failure and recovery behavior, material invariants, and the seams at which they can be proved.

Section bodies are Markdown-rich. Keep them proportional and non-repetitive. The renderer owns level-two (`##`) headings; inside a field use bold labels, lists, tables, or level-three (`###`) headings only.

Do not create intent artifacts, spec/design artifact catalogs, decision artifacts, narrative taxonomy IDs, criterion IDs, or block IDs. Preserve consequential decisions in the relevant story section. Do not define tasks, stages, assignments, worktree strategy, authored evaluations, reports, or handoffs.

## Author the E2E Matrix

E2E is a concise outside-in matrix with:

- one global **Scope** describing the touched journey surface;
- optional global **Exclusions** for deliberately unexercised surfaces or risks; and
- independently authored, stable cases containing only **Exercise**, **Oracle**, and **Proof**.

Give each case a short stable ID and descriptive title. **Exercise** combines only the setup, action/event, and safety details needed to run the journey. **Oracle** states the externally observable result and final state. **Proof** states the evidence that establishes the oracle, using internal evidence only for a named hidden invariant.

Derive cases from real actors, surfaces, rules, transitions, and material risks—not implementation structure. Use the smallest non-duplicate set. Do not restore classifications, criterion mappings, source catalogs, separate actor/pre-state/action/outcome/safety fields, or other verbose case metadata when Exercise, Oracle, and Proof already carry the information.

Write global `e2eScope` and optional `e2eExclusions` through `story_write`. Write each stable `E2E-NNN` case through one flat `e2e_write` call.

## Flat Writer Contract

- Create a story without `ref`: provide `id`, `title`, all seven story sections, and `e2eScope`. Create each case without `ref`: provide `story`, `id`, `title`, `exercise`, `oracle`, and `proof`.
- Update by canonical `ref` and send only changed fields. If stored spec or design structure is invalid, replace its complete four-field or three-field group as directed by the error.
- Require a valid Git `HEAD`, clean worktree, and `develop` or matching feature/fix branch. Flat writers own target-branch creation and harness commits; never repair Git setup manually without user authority.
- `workflow_compile` requires substantive structured sections and at least one E2E case. Standalone `TBD`, `N/A`, `NONE`, uppercase `TODO`, and wrapped placeholder markers are rejected; legitimate “todo” is allowed.

## Validate, Then Persist

Before writing, present a compact checkpoint containing the complete proposed story sections and E2E matrix. State deliberate E2E exclusions and unresolved coverage gaps. Explicitly ask whether the checkpoint represents the user's intent. Prior agreement to “build,” “shape,” or “plan” does not approve an unseen checkpoint.

After the user validates it:

1. Create the story and its cases using the flat writer contract above.
2. Read them back; check structure, placeholders, contradictions, ambiguous terms, missing scenarios, and disagreement between behavior, design, and journeys.
3. Update only the affected field or case, except when an error requires a complete malformed field group.
4. Call near-zero-argument `workflow_compile`. It reads existing resources, reports all deterministic issues, mutates nothing, and authorizes neither planning nor execution. Fix named resources and recompile.

Example content should stay compact:

- Outcome: “A valid checkout creates exactly one order and returns its identifier.”
- Approach: “Route submission through the existing checkout command and preserve its typed result.”
- `E2E-001` — Exercise: “Submit a disposable valid cart through checkout.” Oracle: “One confirmation identifies one created order.” Proof: “Capture the confirmation and query the disposable order, then remove it.”

Use only the specialized flat authoring tools. Do not write raw YAML or use `resource_write`, `workflow_apply_change`, or a generic nested story payload.

## Story Review Gate

After the story is first persisted, present the complete rendered story and E2E checkpoint with its story identity, then stop. Always wait for the user to review it or explicitly ask to proceed to delivery planning—even when the original request asked for an end-to-end plan. Never load or invoke `plan-delivery` in the same turn that first persists the shaped story.

A later explicit request such as “the story looks right, plan it” enters `plan-delivery`. Requested story changes remain in `shape-story`.

## Exit States

End with exactly one result:

1. one focused domain, behavior, or design question;
2. a proposed story section or E2E matrix awaiting correction or validation;
3. a persisted coherent story awaiting explicit user review; or
4. an explicit return to `product-discussion` with the reopened frontier.
