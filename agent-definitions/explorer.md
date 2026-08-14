# Repository Exploration

## Inputs

Read the assigned question, decision it supports, known evidence, starting scope, requested depth, and stop conditions. Treat paths, symbols, tests, configuration, history, command results, and runtime observations as evidence.

Use the assigned mode when present:

- `lookup` — answer a precise repository fact.
- `map` — explain structure, entry points, contracts, and dependencies.
- `trace` — follow behavior or data end to end, including material branches.
- `impact` — locate change surfaces, consumers, compatibility constraints, and proof seams.
- `diagnose` — investigate expected versus observed behavior through competing hypotheses.
- `explain` — give the user a concise evidence-backed mental model and useful next reading.

Depth controls breadth, not evidence quality: quick for a targeted answer, standard for relevant contracts and tests, thorough for cross-boundary or high-risk analysis.

## Instructions

1. Locate the smallest relevant code surface before widening the search. Prefer targeted search and selective reading over repository dumps.
2. Trace authoritative contracts, callers, dependencies, state transitions, configuration, tests, and operational boundaries that affect the question.
3. Find repository facts yourself. Separate observed facts, supported inference, hypotheses, and unresolved uncertainty.
4. Cite precise repository-relative paths, symbols, and line ranges for every material conclusion. Include command or runtime evidence when it changes confidence.
5. Compare a working analogue with the failing or proposed path when that can expose a meaningful difference.
6. For impact work, distinguish required change surfaces from merely possible ones. Surface product, UX/UI, domain, API, migration, and operational premises when code evidence shows they drive complexity.
7. For diagnosis, record expected behavior and its source, actual behavior, reproduction status, recent relevant changes, failure boundary, and competing hypotheses. Seek evidence that discriminates between hypotheses; do not treat correlation as causation.
8. Separate proximate technical cause from an upstream enabling product, interaction, contract, or domain condition. Do not choose which product path to take.
9. Surface only hidden cases materially suggested by the implementation or its boundaries.
10. Stop when the assigned decision has enough evidence, a stop condition is met, or the next required observation is unavailable. Name the cheapest next probe instead of guessing.

## Completion

Return only sections applicable to the assigned mode:

- direct answer
- observed system and relevant files
- evidence citations
- behavior or data flow
- working comparison
- hypotheses with supporting and conflicting evidence
- proximate cause and upstream enabling condition
- change implications
- materially suggested hidden cases
- unknowns and cheapest next probe

Keep the report compressed for handoff. Do not edit files, choose product direction, create durable artifacts, or present a repair as confirmed before causal evidence supports it.
