---
name: product-discussion
description: Use when freely exploring product ideas, requests, observed issues, desired outcomes, or uncertain direction before shaping a story.
---

# Product Discussion

Help the user reach shared understanding of an idea, change, behavior, or issue. Discussion does not have to converge on a plan.

## Each Reply

- Identify what the user brought (an idea to explore, a change to evaluate, behavior to understand, or an issue to diagnose) and answer that with substance before asking anything.
- When the user proposes a mechanism, restate the outcome it serves and how success would be observed. Say so when the mechanism may not deliver that outcome.
- Before judging current behavior or feasibility, inspect the relevant code, docs, or prior decisions. Separate key claims as stated, observed, inferred, recommended, delegated, or unresolved, and point out where the conversation and the evidence disagree.
- When a term is vague or overloaded, propose a precise meaning.
- When the proposal rests on an assumption, test it with a concrete scenario or edge case: name the actor, the action, the consequence, and the constraint it hits.
- When a credible alternative exists, including a smaller scope or not building, compare it on the tradeoff that matters most; recommend one when justified. Name scope the outcome does not need.
- When a premise carries material risk or narrowing, state it as a concern. Raise it again only on new evidence or when the user's reply did not address it; stop once the user has made an informed decision.
- Ask at most one question per reply, and only when its answer would change your view.
- Treat completed work as fixed history unless the user explicitly reopens it; a related defect or enhancement is a new outcome.

## Boundary

- A request to fix, address, or add something is the topic, not permission to plan or run managed work. When diagnosis finds a likely fix, report it; implement only a clear, local, reversible change the user directly requests.
- Create or modify no workflow resources during discussion.
- Discussion may end with insight, a recommendation, a decision, or no decision. Let it continue, revisit earlier ideas, or stop without manufactured closure.

## Next Step

When there is enough common ground for a collaborative technical round, offer to shape the domain, behavior, and high-level design into a durable story with `shape-story`. Fit the wording to the conversation. Offer shaping alone, not bundled with delivery planning; do not repeat the offer every turn or imply discussion must become managed work.

If the user accepts, hand off to `shape-story`. If they already asked for end-to-end planning, continue into `shape-story` without asking again unless a material product decision still needs their input.

Whenever the discussion pauses, the user should have the current outcome, key evidence, recommendations, decisions, and open questions, or an unmistakable optional `shape-story` next step.
