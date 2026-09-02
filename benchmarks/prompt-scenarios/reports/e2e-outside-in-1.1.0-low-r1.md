# E2E outside-in prompt benchmark — low-tier run 1

- Date: 2026-08-19
- Suite: `e2e-outside-in@1.1.0`
- Scorer: `e2e-scorer@1.1.0`
- Method: `benchmarks/prompt-scenarios/FANOUT_METHOD.md`
- Subjects: `general-purpose`, configured `low` tier
- Final evaluator: `general-purpose`, configured `high` tier
- Repetitions: 1 per condition × scenario
- Raw local evidence: `.benchmark/prompt-scenarios/e2e-outside-in/2026-08-19T04-51-11Z/`

## Result

**Mixed. The outside-in candidate is not demonstrably better than the current baseline.**

| Condition | Automatic mean | Automatic pass | Reviewed pass |
| --- | ---: | ---: | ---: |
| `current-baseline` | 65.83 | 2/6 | 3/6 |
| `outside-in-candidate` | 76.67 | 3/6 | 3/6 |

The automatic +10.83 candidate advantage is entirely caused by one baseline response missing its final JSON brace. Excluding that paired scenario, both automatic means are 76.00. Human review passes are tied.

## Scenario conclusions

- **Calendar shaping:** both pass; candidate is somewhat clearer, but not materially better.
- **Calendar planning reconciliation:** both fail exact approved-ID preservation. Candidate surfaces the recurrence contradiction more clearly.
- **Backend migration restraint:** both fail to preserve and prove the binding two-release qualifier; both invent a production-target refusal mechanism not stated in the fixture.
- **Household permissions/privacy:** both pass human review. Automatic failures are scorer false negatives caused by `deny` versus `denied`/`denial` matching.
- **Cross-surface transition:** candidate returns valid JSON and passes; baseline is semantically strong but invalid due to one missing brace. One repetition cannot establish a prompt-level gain.
- **Unavailable platform:** baseline safely preserves exact `E2E-MOB-1` and passes human review. Candidate changes it to `Approved E2E-MOB-1` and fails.

## Prompt changes supported by this run

Do not promote the full candidate. Test only these focused additions next:

1. **Exact identifier preservation:** copy only the identifier token such as `E2E-001`; never include surrounding labels such as `Approved`.
2. **Planning amendment record:** for a contradiction or matrix-changing feasibility issue, name classification, evidence refs, impacted case/requirement IDs, proposed delta, and explicit user-review requirement.
3. **Qualifier and grounding check:** preserve counts, durations, platform qualifiers, and other binding modifiers in a case or explicit gap; do not turn an unstated enforcement mechanism into an expected result.

## Benchmark defects to repair before the next comparison

- Separate exact top-level JSON validity from recovered nested fragments.
- Accept authorization morphology such as `deny`, `denied`, and `denial`.
- Do not require hidden `instructionArtifacts` key names that the neutral output envelope does not specify.
- Present approved IDs unambiguously, for example `Approved case: E2E-001`.
- Make the calendar contradiction incontrovertible by placing some occurrences outside the seven-day view.
- Distinguish a blocked execution environment from a product-matrix amendment.
- Reduce lexical scoring and check binding qualifiers semantically.

## Limitations

- One repetition cannot separate prompt effects from sampling or formatting variance.
- The fan-out manifest records tier policy but not each concrete resolved route, latency, or tokens.
- Findings apply only to the frozen packet hashes in the raw run manifest.
