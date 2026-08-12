---
name: workflow-discover
description: Use when a request needs product discovery, diagnosis, alternatives, or durable clarification before executable planning.
---

# Workflow Discovery

## Goal

Find the right outcome before optimizing the requested solution. Keep ordinary chat conversational; preserve understanding only when durable tracking is useful and the user has requested or accepted it.

## Method

1. Inspect repository facts, current behavior, history, and existing workflow resources before asking answerable questions.
2. Separate **stated**, **observed**, **inferred**, **recommended**, **delegated**, and **unresolved** information.
3. Recover only material context: actor, trigger, current behavior, friction, desired outcome, success signals, guardrails, and non-goals.
4. Treat the requested mechanism as a hypothesis. Step back when it conflicts with evidence, preserves an invalid state, creates repeated exceptions, or is disproportionate. Compare credible alternatives, recommend one, and challenge a risky premise once before respecting an informed choice.
5. For bugs, distinguish symptom, expectation, reproduction, proximate cause, upstream enabling condition, mitigation, repair, and prevention. Diagnose before promising a repair.
6. Probe hidden cases only when they could change outcome, scope, architecture, product contract, delivery, verification, rollout, or recovery.
7. Ask one pivotal question when it can reframe the work; otherwise ask a short numbered set of independent decisions with recommendations. Stop when further answers would not materially change delivery.

## Durable Checkpoints

Discovery is read-only by default. When the user wants durable tracking or a substantial discussion must survive sessions:

- call `workflow_list` and reuse a matching draft;
- otherwise create one minimal story/change through `workflow_create`;
- checkpoint only meaningful changes to intent, observed context, settled boundaries, success signals, assumptions, open questions, or genuinely settled decisions;
- never write every turn, harden tentative ideas, define tasks/evaluations, or submit for approval.

A clear request may skip discovery and go directly to `workflow-plan`. A small, local, reversible request may remain ad hoc.

## Handoff

Conclude with: outcome, observed context, recommended direction, settled decisions, material open questions, scope boundaries, and success signals. Route to ordinary chat, ad-hoc work, or `workflow-plan`.
