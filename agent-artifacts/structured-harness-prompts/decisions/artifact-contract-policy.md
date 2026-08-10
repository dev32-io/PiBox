# Artifact Contract Policy

## Decision

Apply semantic structure validation to every harness-owned Markdown surface: work-item intent, specifications, designs, decisions, task briefs, task acceptance contracts, evaluation reports, outcomes, skills, role prompts, and dynamic runtime prompts. Ordinary project documentation remains outside this validator.

Classify artifact sections as required, optional, or conditional. Required and applicable conditional sections must contain substantive visible content. Optional and non-applicable conditional sections may be omitted. A visible `Not applicable — <reason>` statement may document material non-applicability; hidden comments, empty headings, placeholders, and bare `N/A` do not satisfy a contract.

Use hybrid conditional applicability. Capabilities enforce deterministic triggers available from structured state or explicit artifact signals; models and reviewers judge semantic conditions that cannot be inferred reliably.

Use stable identifiers only for information that crosses artifact boundaries:

- Specification acceptance criteria use artifact-local IDs such as `AC-001`.
- External references qualify the criterion as `<artifact-id>#AC-001`.
- Tasks and evaluations reference qualified criteria.
- Findings retain their existing stable IDs.
- Evidence IDs are generated deterministically by capabilities.
- Decision artifacts use their artifact ID without redundant paragraph-level IDs.

## Context

Free-form Markdown makes key decisions difficult to locate and prevents deterministic traceability checks. Requiring every possible section or assigning an ID to every paragraph would replace that ambiguity with filler and administrative noise.

## Rationale

Stable semantic sections improve scanning, synthesis, review, and recovery for both humans and models. Omission preserves proportionality for irrelevant concerns. Visible non-applicability rationale communicates a real decision when one matters. Minimal stable identity supports the binding chain from specification criterion through task, integration unit, evaluation, evidence, and finding without turning narrative documents into databases.

## Consequences

- Artifact capabilities must validate section structure before mutation.
- Task and evaluation schemas need qualified criterion-reference fields or an equivalent structured mapping.
- Validation diagnostics must name the artifact, section or reference, and failed condition.
- New and materially updated artifacts follow the contract; legacy artifacts remain readable.
- Prompt evaluation must verify that models omit irrelevant optional sections rather than generating filler.
- Project-owned Markdown remains governed by project conventions, not the harness.

## Alternatives Considered

- Advisory warnings were rejected because downstream agents could not rely on canonical shape.
- Requiring every section was rejected because it creates filler and unnecessary ceremony.
- Hidden comments as section content were rejected because they are not human-readable and create a validation loophole.
- Fully automatic applicability inference was rejected because many conditions require semantic judgment.
- IDs on every section or bullet were rejected because they add noise without improving cross-artifact traceability.
