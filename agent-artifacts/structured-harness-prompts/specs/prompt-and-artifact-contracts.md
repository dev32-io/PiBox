# Prompt and Artifact Contracts

## Context

PiBox harness prompts currently describe identities more often than executable behavior, while harness-owned Markdown artifacts accept arbitrary non-empty prose. Prompt and artifact structure should make phase boundaries, decisions, criteria, evidence, and residual risk easy for humans and agents to locate without imposing the same ceremony on every change.

## Actors

- The user owns intent, approval, and decisions requiring user authority.
- The main Pi session routes work, synthesizes judgment, and owns canonical artifacts.
- Specialists execute bounded research, implementation, review, test, or repair instructions.
- Deterministic capabilities validate, render, and persist mechanical structure.

## Required Behaviors

- A compact always-loaded orchestrator contract routes the main session into progressively disclosed workflow skills.
- Every skill and role prompt states actionable inputs, instructions, completion criteria, and escalation conditions appropriate to its boundary.
- Prompt descriptions act as trigger-only context pointers rather than workflow summaries.
- All harness-owned Markdown surfaces are governed: intent, specifications, designs, decisions, task briefs, task acceptance contracts, evaluation reports, outcomes, skills, role prompts, and dynamic runtime prompts. Ordinary project documentation is not governed by the harness artifact validator.
- Canonical narrative capabilities accept typed semantic section values and render stable Markdown.
- Sections are classified as required, optional, or conditional by artifact type.
- Required sections contain substantive visible content.
- Optional sections may be omitted when irrelevant.
- Conditional sections are included when their observable applicability condition is true.
- When the absence of a section is itself a material decision, visible concise rationale such as `Not applicable — <reason>` may satisfy the section contract.
- Additional headings are allowed after the required contract remains legible.
- Hidden comments, placeholders, headings with no body, and generic filler do not satisfy required or applicable conditional sections.
- Stable identifiers make acceptance criteria, findings, and evidence references checkable where practical without assigning IDs to ordinary prose.
- Existing committed artifacts remain readable; strict validation applies to newly created or materially updated artifacts under the new contract.
- Canonical mutation capabilities serialize concurrent Git operations before they reach the repository index.

## Acceptance Criteria

- **AC-001:** No built-in role prompt relies on a `You are ...` identity preamble to communicate its instructions.
- **AC-002:** Every built-in prompt surface is inventoried as a skill, role prompt, dynamic runtime prompt, protocol prompt, fallback prompt, or tool-description pointer.
- **AC-003:** Each skill description specifies invocation conditions without summarizing its procedure.
- **AC-004:** Each rewritten prompt has baseline scenarios, observable success criteria, and recorded before/after evaluation.
- **AC-005:** Artifact creation or material update fails with `INVALID_ARTIFACT` when a required section value is missing, empty, hidden in a comment, or filled only with placeholder text.
- **AC-006:** An optional section can be omitted without failure.
- **AC-007:** An applicable conditional section is required; a non-applicable conditional section can be omitted or can contain a concise visible rationale.
- **AC-008:** Validators report the artifact type, section or field, and failed semantic condition, including deterministic applicability triggers when relevant.
- **AC-009:** Additional meaningful headings remain valid and cannot collide with reserved headings.
- **AC-010:** Acceptance criteria have stable artifact-local identifiers, external references use `<artifact-id>#AC-NNN`, and task/evaluation references are validated deterministically.
- **AC-011:** Evaluation reports and outcomes present their boundary, evidence or verification, verdict or delivered result, and residual findings in stable locations rendered from structured state where available.
- **AC-012:** Prompt and artifact changes preserve ad-hoc Pi work and proportionate managed workflow decisions.
- **AC-013:** Unit tests cover every artifact profile, required/optional/conditional behavior, placeholder rejection, stable identifiers, structured rendering, and backward compatibility.
- **AC-014:** Cheap-model behavioral scenarios exercise each prompt refinement before that prompt is accepted.
- **AC-015:** Simultaneous canonical mutation calls are serialized by the harness, produce complete atomic commits in a deterministic order, and do not surface a Git `.git/index.lock` race.
- **AC-016:** Failed validation or rendering leaves files, catalogs, planning revision, and Git state unchanged.

## Edge Cases

- A semantic value or additional-section body containing only whitespace, an HTML comment, `TBD`, `TODO`, `N/A`, or equivalent generic filler is empty.
- A concise visible non-applicability statement must give a reason; bare `N/A` is insufficient.
- Text inside code fences that resembles a heading does not define an additional artifact section.
- Duplicate reserved headings or additional headings with reserved names fail with a precise diagnostic.
- Conditional applicability that cannot be determined mechanically remains a model judgment and is checked by review rather than guessed by the validator.
- Removed acceptance criteria are not silently renumbered and dangling qualified references fail.
- Legacy artifacts are not rewritten or rejected merely because they predate the contract.
- Concurrent mutations within one process or across managed capability invocations cannot race at Git's index.

## Out of Scope

- Enforcing identical document length or prose style.
- Requiring every optional section for every work item.
- Replacing Markdown narrative with fully structured YAML.
- Applying harness artifact contracts to arbitrary project README or documentation files.
- Using prompt rules where an existing capability can enforce the invariant.
- Rewriting all prompts in one untested batch.
