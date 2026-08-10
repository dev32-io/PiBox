# Artifact Profiles

## Design Goal

Define typed semantic inputs and deterministic Markdown renderers for every harness-owned canonical narrative. This design satisfies `prompt-and-artifact-contracts#AC-005` through `AC-013` and implements the policies in `artifact-contract-policy` and `structured-artifact-rendering`.

## Chosen Approach

Create a versioned artifact-contract registry. Each profile declares reserved headings, typed fields, required/optional/conditional rules, substantive-content checks, deterministic triggers, and a renderer. Canonical mutation tools accept profile-specific semantic values. Rendered Markdown remains ordinary, readable, committed text.

Profiles:

### Intent

Required: Problem, Desired Outcome, Scope/Included, Success Signals. Optional: Scope/Excluded, Constraints, Assumptions, Open Questions. Open questions carry authority and disposition; unresolved questions without either block planning submission.

### Specification

Required: Context, Required Behaviors, Acceptance Criteria. Conditional: Actors and Edge Cases. Optional: Constraints, Assumptions, Out of Scope, Open Questions. Acceptance criteria use stable `AC-NNN` IDs that are unique within the artifact and remain stable across updates.

### Design

Required: Design Goal, Chosen Approach, Verification Boundaries. Conditional: Components and Interfaces, Data and Control Flow, Failure and Recovery, Security and Privacy, Compatibility and Migration. Optional: Alternatives Considered and Open Questions. Specification references use `<artifact-id>#AC-NNN`.

### Decision

Required: Decision, Context, Rationale, Consequences. Optional: Alternatives Considered and Revisit When. Consequences are typed as benefit, cost, limitation, or obligation. The artifact ID is the decision ID.

### Task brief

Required: Contribution Goal, Boundary/Included, Required Work, Integration Expectation. Optional: Boundary/Excluded, Constraints, Risks and Uncertainties. Interfaces and Dependencies is conditional when the task consumes, produces, or changes a shared contract. References, dependencies, assignment, workspace, and integration metadata are rendered from `task.yaml`.

### Task acceptance

Required: Deliverables, Criterion Contributions, Boundary Proof. Expected Intermediate State is required when `intermediateState` is `partial`. Integration Proof is required when binding behavior becomes provable only after assembly. Commands remain in structured verification policy rather than being duplicated.

### Evaluation report

Required rendered sections: Boundary, Criteria Evaluated, Observations, Evidence, Findings, Verdict, Residual Risk. Boundary and criterion references come from the evaluation manifest; evidence, findings, and verdict come from the structured terminal handoff. `Residual Risk` may be an explicit empty collection rendered as `None recorded` because the capability, not prose, makes that assertion.

### Outcome

Required: Delivered and Verification. Conditional: Contract Deviations, Remaining Findings, and Follow-up. Verification is rendered from canonical integration and evaluation results. Remaining Findings is generated from unresolved non-blocking findings. Empty conditional sections are omitted.

## Components and Interfaces

- A registry maps artifact profile and schema version to field definitions, trigger predicates, validation, and rendering.
- Mutation tools expose discriminated typed inputs per profile.
- A compatibility adapter retains reads of schema-v1 free-form artifacts and can parse them for display without asserting conformance.
- `planning_submit` validates all current contract artifacts, unresolved questions, criterion uniqueness, and structured references.
- Task and evaluation manifests gain structured qualified criterion references.
- Evaluator terminal handoff replaces the free-form report with criteria, observations, residual risks, evidence, findings, and verdict fields.
- Completion input supplies delivered items, deviations, and follow-up; verification and remaining findings are capability-owned.

## Data and Control Flow

1. A model calls a canonical capability with typed semantic fields.
2. The profile validator rejects empty or placeholder values, invalid identifiers, duplicate reserved headings in additional sections, and unmet deterministic conditions.
3. Cross-reference validation resolves qualified criteria against current specification profiles.
4. The renderer emits headings in registry order and omits absent optional or non-applicable conditional sections.
5. The store atomically writes rendered Markdown and associated structured metadata, then advances planning revision when material.
6. Readers continue consuming Markdown; capabilities use structured metadata for deterministic checks.

## Failure and Recovery

Validation and rendering complete before any file mutation. Errors include profile, field or section, rule, and deterministic trigger. Failed updates preserve prior files and planning metadata. Legacy reads remain available. Migration never rewrites committed artifacts automatically.

Canonical mutation capabilities must serialize concurrent invocations before Git operations. A simultaneous mutation attempt must wait or return a harness-level lock result; it must not race at `.git/index.lock`. This requirement was confirmed during planning when two parallel artifact creations failed at Git's index lock without committing partial state.

## Security and Privacy

Renderers escape or safely preserve user-provided Markdown without executing it. Parsers bound input size, ignore headings inside fenced code and HTML comments, and avoid logging secret field values. Security-related deterministic triggers report the category that fired, not sensitive content.

## Compatibility and Migration

Introduce schema-v2 typed inputs while retaining schema-v1 reads. Existing work items may finish under their approved schema. A material update can explicitly migrate one artifact through its canonical capability; after migration that artifact follows the v2 contract. Tool descriptions identify the active contract version.

## Verification Boundaries

- Registry and renderer unit tests prove all profiles, ordering, omission, placeholder rejection, stable IDs, and additional-section collision handling.
- Store tests prove pre-mutation failure and legacy reads.
- Traceability tests prove qualified criterion resolution through task and evaluation manifests.
- Lifecycle tests prove unresolved-question submission failures and schema-v1 completion compatibility.
- Concurrency tests invoke canonical mutations simultaneously and prove harness serialization prevents Git index-lock races and partial commits.
- E2E proves rendered intent, specification, design, tasks, evaluation report, and outcome remain readable and complete.

## Alternatives Considered

A single universal Markdown template was rejected because artifact purposes differ. Parsing only model-authored Markdown was rejected because it retains avoidable formatting retries. Immediate bulk migration was rejected because it would rewrite approved historical contracts without semantic review.
