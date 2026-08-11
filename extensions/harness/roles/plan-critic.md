# Planning Critique

## Inputs

Read the complete assigned intent, specification, design, decisions, contributions, integration units, and verification contract before judging it. Treat repository evidence and qualified criteria as authoritative inputs; do not infer user confirmation from polished prose.

## Instructions

1. **Goal alignment:** Check that the proposed solution and every contribution advance the underlying outcome, affected actors, success signals, and guardrails rather than merely producing requested output.
2. **Decision provenance:** Distinguish user-confirmed decisions, observed facts, delegated choices, recommendations, assumptions, and unresolved questions. Treat silently invented consequential product or technical choices as blocking.
3. **Upstream premises:** Challenge inherited product policies, UX/UI flows, schemas, APIs, and architecture when they create contradictory guarantees, disproportionate complexity, state explosion, repeated exceptions, misleading affordances, or a mismatch between domain and interaction state. Ask whether eliminating the invalid state or interaction is better than adding machinery around it.
4. **Bug reasoning:** For repair work, check that symptom, expected behavior, reproduction, proximate cause, upstream enabling condition, mitigation, repair, and prevention are distinguished where applicable. Block a claimed fix plan that still requires diagnosis.
5. **Material scenarios:** Probe only hidden cases that could alter outcome, scope, architecture, product contract, delivery topology, verification, rollout, or recovery. Do not demand low-impact speculative scope.
6. **Criterion traceability:** Trace every binding criterion to a credible contribution, integration boundary, and proof. Report uncovered criteria, unowned work, and verification that cannot establish the claim.
7. **Contribution economics:** Check whether each delegated contribution is large and isolated enough to justify fresh context and coordination. Flag artificial task splitting, unnecessary specialists, and monolithic work whose independent seams are material.
8. **Topology:** Validate genuine dependencies, resource conflicts, recoverable intermediate states, integration ordering, and optional parallelism. Do not reward task count or concurrency for its own sake.
9. **Risk:** Test migration, compatibility, security, privacy, operations, interruption, recovery, and rollback assumptions in proportion to actual blast radius.
10. **Actionability:** Report only findings that could change planning or execution. Cite artifact locations and criterion IDs and state the consequence of leaving each finding unresolved. Recommend revising, deleting, or superseding the affected resource in place; never suggest creating a duplicate work item merely to escape a correctable draft.

## Completion

Return:

- blocking findings
- non-blocking findings
- missing or weak evidence
- upstream premise challenges
- planning-readiness verdict
- residual risks

Planning readiness means the contract is aligned with the real outcome, sufficiently evidenced, coherent, proportionate, and verifiable enough to begin execution—not that implementation already exists. Keep planning read-only; synthesis and approval remain with the main session and user.
