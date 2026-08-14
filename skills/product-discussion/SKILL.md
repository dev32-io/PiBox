---
name: product-discussion
description: Use when freely exploring product ideas, requests, observed issues, desired outcomes, or uncertain direction before shaping a story.
---

# Product Discussion

Think with the user in an open room. Help them get beyond the feature, defect, or mechanism immediately in front of them and reach useful shared understanding without forcing convergence, workflow ceremony, or a plan.

## Follow the Conversation

1. **Orient** — Identify what the user brought: an idea to explore, a change to evaluate, behavior to understand, or an issue to diagnose. Respond substantively before interviewing them; use the classification to choose your stance, not to impose ceremony.
2. **Ground** — Inspect repository facts, current behavior, or prior decisions when evidence would improve the discussion. Separate what the user stated from what was observed, inferred, recommended, delegated, or remains unresolved. Surface contradictions between the conversation and the evidence.
3. **Uncover** — Recover the desired outcome behind a proposed mechanism. Sharpen vague or overloaded terms, test assumptions with concrete scenarios and edge cases, and clarify the actors, consequences, constraints, and success signals that matter.
4. **Explore** — Use diagnosis, option comparison, product critique, or technical explanation as the conversation requires. Lead with a recommendation when one is justified, compare credible alternatives and tradeoffs, and remove unnecessary scope. Challenge a materially risky or narrowing premise once, then respect the user's informed direction.
5. **Align** — Reflect the current outcome, evidence, decisions, and open frontier. Ask one useful question at a time when another answer would materially improve understanding. Let the conversation continue, revisit earlier ideas, or end without manufacturing closure.

Keep finished work as history unless the user explicitly chooses to reopen it. Treat a related defect or enhancement as a new conversational outcome by default.

## Boundary

Discussion can end with insight, a recommendation, a decision, or no decision. Do not create or modify canonical workflow resources merely because the conversation becomes substantial.

A request to fix, address, or add something is the subject of discussion, not permission to plan or execute managed work. Diagnosis may identify a likely fix, but do not silently cross from understanding into implementation. Clear, local, reversible implementation may still remain ad hoc when the user directly requests it.

## Natural Next Step

When there is enough common ground to begin a collaborative technical round, offer to shape the domain, behavior, and high-level design into a durable story. Fit the wording to the conversation; do not bundle story shaping and delivery planning into one offer, push this on every turn, or imply that discussion must become managed work.

If the user chooses to shape the outcome, hand off to `shape-story`. If they already requested end-to-end planning, continue into `shape-story` without asking them to repeat permission unless one material product decision still needs their input.

## Deliverable

Leave the user with useful thinking: the current outcome, important evidence, recommendations, decisions, and unresolved questions. Either continue the discussion freely or make the optional `shape-story` next step unmistakable.
