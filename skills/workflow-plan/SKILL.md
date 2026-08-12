---
name: workflow-plan
description: Use when understood intent needs a durable executable contract, contribution plan, verification, and direct user approval.
---

# Workflow Planning

## Boundary

Translate shared understanding into an executable contract. Do not repeat broad discovery; return to discussion if a material product decision remains. A mixed request for a change plus ideas, alternatives, or “what next” has not reached this boundary until that frontier is discussed. Canonical capabilities are the only writers of `agent-artifacts/`.

## Build the Contract

1. Call `workflow_list` and identify the outcome currently being discussed. Revise a matching resource only when it is that current unfinished outcome. Finished or delivered stories/changes are immutable history by default; reopen or extend one only when the user specifically chooses that exact work item. Related code, criteria, or product area does not make it the current target. New follow-up defects, enhancements, and grouped increments normally get a new parent through `workflow_create`, followed by its children. Use `workflow_apply_change` only for genuinely coherent multi-resource changes.
2. Preserve provenance. Record confirmed or delegated choices without turning recommendations, silence, or preferred technology into user requirements.
3. Specify outcome, included/excluded scope, stable observable acceptance criteria, constraints, assumptions, and material edge cases before implementation design.
4. Add only useful specifications, designs, and decisions. Prefer the smallest set that makes implementation and review unambiguous.
5. Define delivery independently from work-item size:
   - `feature` for capabilities, enhancements, and refactors; `fix` for defects or regressions;
   - `create` from updated `develop`, or `continue` on the explicitly current ongoing feature/fix branch;
   - ask only when that choice materially changes delivery.
6. Design coherent vertical contributions. Keep tiny or tightly coupled work together. Use ordered stages; concurrency only for independent work with compatible files/resources. Use repository isolation for serial branch work and worktrees only when isolation or parallelism repays overhead.
7. Give every task a clear outcome contribution, boundary, dependencies/interfaces, expected intermediate state, integration expectation, model assignment, and cheapest meaningful proof.
8. Map binding criteria to tasks and verification. Add independent review, E2E, migration, or diagnostic work only when risk warrants it. Use a plan critic only for consequential ambiguity, blast radius, or decomposition risk.

## Readiness

Do not submit while material choices remain unresolved. Low-impact uncertainty may be an assumption or residual risk. When coherent, call `workflow_transition` with `submit`, summarize outcome, scope, decisions, stages, and verification, then offer conversational refinement or `/workflow approve <work-item-id>`.

Refine through `workflow_patch` or a coherent `workflow_apply_change`. Initial approval is user-only; approved amendments may retain approval only within delegated intent.
