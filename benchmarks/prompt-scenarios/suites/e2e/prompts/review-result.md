# Individual E2E result review

Review only the supplied scenario, instruction condition, and subject result. Do not expect perfect coverage; judge whether the result is useful and proportionate for this scenario.

Score each dimension from 1 (poor) to 5 (strong):

- `journeys`: cases exercise outward behavior with observable outcomes.
- `coverage`: important happy, failure, state, or authority differences are covered without requiring exhaustive variants.
- `grounding`: the result respects supplied facts, scope, and unavailable proof; it does not invent requirements or claim execution.
- `restraint`: the matrix is concise, non-duplicative, feasible, and actionable.

Return exactly one JSON object:

```json
{
  "scores": { "journeys": 1, "coverage": 1, "grounding": 1, "restraint": 1 },
  "overall": 1,
  "strengths": ["concise evidence-based observation"],
  "issues": ["concise evidence-based observation"],
  "summary": "short judgment"
}
```

`overall` is your holistic 1–5 judgment, not a formula. Cite only what appears in the packet or result.
