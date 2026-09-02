# E2E outside-in benchmark — v2.0.0 low-tier run 1

- Date: 2026-08-19
- Suite: `e2e-outside-in@2.0.0`
- Review method: per-result low-tier reviewer, final high-tier reviewer
- Repetitions: 2 per condition × scenario
- Raw local evidence: `.benchmark/prompt-scenarios/e2e-outside-in/2026-08-19T06-48-16Z/`


## Method

Reviewed the manifest and all 20 saved packet/response/review triplets, comparing the frozen `current-baseline` with `outside-in-candidate` under the final-review rubric. All 20 responses were present and non-empty. All 20 review JSON files parsed and had the exact expected fields, all four rubric dimensions, integer scores within 1–5, and well-formed narrative fields. Scores below are descriptive observations from two volatile samples per condition, not deterministic or statistical evidence.

## Per-scenario comparison

| Scenario | Current baseline — individual scores; mean; range | Outside-in candidate — individual scores; mean; range | Reading of the outputs |
|---|---|---|---|
| Web upload recovery | 5, 5; **5.0**; **5–5** | 5, 4; **4.5**; **4–5** | **Mixed, with no meaningful candidate advantage.** Both produce the same three useful journeys. The candidate more explicitly frames actors/final state and the no-upload storage call as a hidden invariant, but one response omits the source references required only by the candidate instruction and leaves JPG interpretation open; its added visible-validation/prior-avatar details also prompted grounding concern. |
| Household delete permission | 5, 4; **4.5**; **4–5** | 5, 5; **5.0**; **5–5** | **Directional candidate advantage in restraint.** Candidate responses use two authority-distinct journeys and retain the title non-disclosure invariant, while baseline responses add cancellation/retry cases that substantially overlap the core owner/editor paths; one baseline run also leaves shared-state sequencing and the editor action path unclear. The candidate still omits explicit source refs, and reviewers treated that omission inconsistently. |
| Backend migration restraint | 5, 4; **4.5**; **4–5** | 4, 5; **4.5**; **4–5** | **Mixed.** Candidate responses reduce four baseline cases to three operator transitions—migration, interrupted retry, and rollback—removing the baseline’s underspecified generic failure case. However, candidate coverage does not turn the two-release API promise into an explicit verification boundary, omits source refs, and varies rollback classification; baseline has its own unresolved rollback-contract wording. |
| Cross-surface task planning | 5, 5; **5.0**; **5–5** | 4, 4; **4.0**; **4–4** | **Meaningful baseline advantage.** Both candidate outputs move completion into the disconnected period, despite the supplied contract saying sync disconnects *after* the web action. They also use the API to corroborate persisted completion although the packet grants it only canonical-identity corroboration. Baseline outputs preserve the required event order, though they too overreach somewhat on API state evidence. |
| Unavailable iOS planning | 5, 5; **5.0**; **5–5** | 5, 4; **4.5**; **4–5** | **Mostly equivalent, with a slight baseline edge.** Both preserve separate Android/iOS journeys, keep iOS blocked, and avoid treating compilation or Android evidence as iOS proof. Candidate adds useful actor and cleanup detail, but one run invents a “share-ready until dismissal” state and again lacks required source refs; baseline stays closer to the supplied contract. |

## Overall pattern

The candidate’s outside-in language appears useful where it suppresses duplicate cases and foregrounds actor, final state, user-visible oracle, and safe cleanup—most clearly in household deletion and, with caveats, migration. In these saved outputs, that benefit is not consistent: source references are routinely absent despite the new explicit requirement, and the cross-surface pair changes a material event sequence in both repetitions. Reviewer judgments also vary on similar omissions (especially source refs and invented details), so score differences should be read alongside the outputs rather than as automatic semantic measurements.

## Limitations

This run contains only two responses per condition per scenario, all from the configured low-tier subject/reviewer route. It cannot establish repeatability, causation, or general prompt superiority. No response was missing, so qualitative differences are not confounded with empty-output handling, but scenario ambiguity remains around source-ref format, JPG definition, rollback semantics, API proof capability, and whether extra cancellation/failure variants are warranted.

## Recommendation

**Revise and rerun.** Keep the candidate’s minimal actor/journey/oracle framing, but require a concrete source-ref convention, tighten “do not invent behavior,” and clarify that event ordering and stated evidence capabilities are binding. The repeated cross-surface contract drift is too consequential to promote this candidate from this small sample; retaining the baseline is safer until a revised candidate is rerun.
