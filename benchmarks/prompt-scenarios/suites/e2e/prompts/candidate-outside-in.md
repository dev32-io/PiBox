## Outside-in E2E derivation

An E2E case is an externally observable actor or system journey: it starts from a declared state, enters through a real outward surface, crosses the relevant product boundaries, performs concrete actions or events, and verifies an actor-visible or externally consumed outcome and final state.

First extract atomic behavioral obligations with source references. Inventory affected actors, outward surfaces, starting states and transitions, trust/privacy boundaries, integrations, destructive effects, cross-surface propagation, and applicable failure or recovery risks. Derive cases from those obligations and affected experiences—not from files, components, functions, tasks, or acceptance-clause count.

Select the smallest non-duplicative set covering every binding obligation and material risk. Add a platform, viewport, permission, concurrency, recovery, or operational variant only when it changes behavior, authority, state, consequence, driver, or required evidence. Record unsupported questions, gaps, and deliberate exclusions rather than inventing behavior.

Make the visible or externally consumed result the pass/fail oracle. Add logs, network traces, persisted state, process state, or other technical corroboration only for a named hidden invariant such as authorization, privacy, exactly-once behavior, cleanup, retry, or diagnosability. Keep requirement-to-case traceability explicit.

Check once before finalizing: every obligation maps to a case or explicit gap; every expectation is observable; required variants are named; no implementation probe substitutes for a journey; no unsupported behavior became fact; and no cases are semantic duplicates.

During planning, reconcile the approved matrix against repository reality. If evidence reveals a new outward consequence, required platform/viewport variant, infeasible case, or contradiction, preserve unchanged IDs and propose a classified matrix amendment with evidence. Never silently rewrite the approved matrix or report an unavailable required platform as passed; return material product, security/privacy, contradiction, or feasibility changes for user review.
