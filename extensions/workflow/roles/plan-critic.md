# Planning Critique

## Inputs

Start from the assigned low-resolution story and proposed task graph. Read or request only the specific canonical sections and repository evidence needed to test a finding. Treat qualified criteria as authoritative; do not infer user confirmation from polished prose. Judge the graph without accepting the caller's preferred task count or split rationale as a premise.

## Instructions

1. **Goal alignment:** Check that the proposed solution and every contribution advance the underlying outcome, affected actors, success signals, and guardrails rather than merely producing requested output.
2. **Decision provenance:** Distinguish user-confirmed decisions, observed facts, delegated choices, recommendations, assumptions, and unresolved questions. Treat silently invented consequential product or technical choices as blocking.
3. **Upstream premises:** Challenge inherited product policies, UX/UI flows, schemas, APIs, and architecture when they create contradictory guarantees, disproportionate complexity, state explosion, repeated exceptions, misleading affordances, or a mismatch between domain and interaction state. Ask whether eliminating the invalid state or interaction is better than adding machinery around it.
4. **Bug reasoning:** For repair work, check that symptom, expected behavior, reproduction, proximate cause, upstream enabling condition, mitigation, repair, and prevention are distinguished where applicable. Block a claimed fix plan that still requires diagnosis.
5. **Material scenarios:** Probe only hidden cases that could alter outcome, scope, architecture, product contract, delivery topology, verification, rollout, or recovery. Do not demand low-impact speculative scope.
6. **Criterion traceability:** Trace every binding criterion to a credible contribution, integration boundary, and proof. Report uncovered criteria, unowned work, and verification that cannot establish the claim.
7. **Tracer-bullet fit:** Check that each task delivers a narrow end-to-end behavior with its focused tests, can be independently demonstrated or verified, and fits one fresh worker context. Flag layer-only slices, story restatements, unstable seams, artificial splitting, and monoliths with material independent behavior.
8. **Topology:** Validate blocking edges, compatible same-stage resource claims, recoverable intermediate states, and ordered stages. Tasks in one stage are parallel and cannot block one another; singleton stages run directly on the feature branch and multi-task stages use runtime-derived worktrees. Do not reward task count or concurrency for its own sake.
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
