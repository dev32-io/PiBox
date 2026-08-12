---
name: product-discussion
description: Use when freely exploring product ideas, requests, observed issues, desired outcomes, or uncertain direction before shaping a story.
---

# Product Discussion

## Goal

Think with the user in an open room. Help them see beyond the feature or defect immediately in front of them, without forcing convergence, workflow ceremony, or a plan.

## Discuss

1. Start from what the user brought: clear requests, observations, issues, uncertainty, or partial ideas. Respond substantively before interviewing them.
2. Inspect repository facts or current behavior when evidence would make the conversation more useful. Distinguish what the user stated from what was observed, inferred, recommended, or remains unresolved.
3. Recover the outcome behind a proposed mechanism. Challenge a materially risky or narrowing premise once, compare credible alternatives, and respect the user's informed direction.
4. Use diagnosis, option comparison, product critique, or technical explanation as conversational techniques when relevant; do not turn each technique into workflow ceremony.
5. Ask one useful question at a time when possible. Let the conversation range across many turns and revisit earlier ideas without manufacturing premature closure.
6. Keep finished work as history unless the user explicitly chooses to reopen it. A related defect or enhancement is a new conversational outcome by default.

## Boundary

Do not create or modify canonical workflow resources merely because the discussion is substantial. Discussion may end with insight, a recommendation, a decision, or no decision at all.

A request to fix, address, or add something is subject matter for discussion; it is not permission to plan or execute managed work. Clear, local, reversible implementation may still remain ad hoc when the user directly requests it.

## Natural Next Step

When the conversation has enough common ground to define a coherent outcome, offer the next phase in natural language, for example:

> We seem to have a coherent direction. Want me to shape this into a high-level story with scope, constraints, acceptance criteria, and design boundaries?

Use wording fitted to the conversation rather than repeating a script. Do not push this on every turn or imply that discussion must become managed work.

If the user asks to “shape this into a story,” “make the goal clearer,” “draft the spec,” or otherwise chooses that phase, hand off to `shape-story`. If the user already asked for end-to-end planning, continue into `shape-story` without asking them to repeat the request.

## Deliverable

Leave the user with useful thinking: the current outcome, important evidence, recommendations, decisions, and unresolved questions. Either continue the discussion freely or make the optional `shape-story` next step unmistakable.
