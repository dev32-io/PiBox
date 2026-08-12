---
name: shape-story
description: Use when shaping product discussion into a high-level story, product contract, specification, design boundary, or explicit scope.
---

# Shape Story

## Goal

Turn shared product understanding into a coherent, reviewable high-level story. Define what should be delivered and what observable behavior proves success before decomposing technical tasks.

## Input Boundary

Enter when the user chooses to shape the discussion into a story, goal, scope, specification, or plan whose product intent is not yet explicit enough for delivery decomposition.

Call `workflow_list` before creating anything. Continue a matching draft only when it represents the current unfinished outcome. Finished or delivered work is history unless the user explicitly chooses to reopen or extend that exact work item; grouped follow-up work normally gets a new parent.

## Shape the Contract

1. Create or reuse the current unfinished story/change through canonical capabilities.
2. Clarify the problem, desired outcome, actors, included and excluded scope, constraints, assumptions, edge cases, and success signals.
3. Resolve consequential product alternatives and expose unknowns that could materially change behavior, scope, policy, privacy, compatibility, rollout, or recovery.
4. Inspect repository behavior and interfaces where they constrain the high-level contract. Do not confuse implementation detail with a user requirement.
5. Write only the high-level artifacts that make the outcome reviewable:
   - intent;
   - specification with stable observable acceptance criteria;
   - design boundaries and product-relevant control flow;
   - consequential decisions when alternatives need durable rationale.
6. Refine these artifacts conversationally with the user. Preserve provenance: confirmed choices are requirements; recommendations, silence, and defaults are not.
7. Do not define tasks, stages, model assignments, worktree isolation, or evaluations in this phase.

## Product Checkpoint

A coherent story answers:

- What outcome are we pursuing, for whom, and why?
- What behavior is included and explicitly excluded?
- What constraints and edge cases bind the solution?
- Which observable criteria prove the outcome?
- What high-level design boundaries make later delivery planning safe?

If one material product decision remains, ask that question. If discussion opens back up materially, return to `product-discussion` rather than hardening tentative ideas.

## Natural Next Step

When the high-level story is coherent, present a compact story checkpoint and offer the next phase in natural language, for example:

> The story now has a clear outcome, scope, acceptance criteria, and design boundary. Want me to turn it into an execution-ready delivery plan with tasks, sequencing, assignments, and verification?

If the user originally requested end-to-end planning, or clearly says to continue planning, hand off to `plan-delivery` in the same turn unless a material product checkpoint needs their decision. Do not stop after creating a draft merely to ask permission the user already gave.

## Deliverable

End with exactly one result:

1. a coherent high-level story checkpoint plus the offered `plan-delivery` next step;
2. one material product question blocking coherence; or
3. an explicit return to `product-discussion` with the reopened frontier.
