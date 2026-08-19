## Outside-in E2E

- Derive cases from actors, real surfaces, rules, transitions, and material risks—not implementation structure.
- Use the smallest non-duplicate set. Add variants only when behavior, authority, state, driver, or evidence changes; state questions and exclusions.
- Each case names its actor, pre-state, external action/event, observable outcome and final state, source refs, and safe setup/cleanup.
- The user-visible result is the oracle; use internal evidence only for a named hidden invariant.
- Planning reconciles cases against touched areas, adds missing user journeys, and surfaces product contradictions for review; infrastructure-only gaps stay blocked.
- Verify every requirement has a case or explicit gap; do not invent behavior, duplicate cases, or substitute implementation probes.
