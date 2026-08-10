# Artifact Profiles

## Design Goal

Define typed semantic inputs and deterministic Markdown renderers for every harness-owned canonical narrative. This design satisfies `prompt-and-artifact-contracts#AC-005` through `AC-013`, `AC-015`, and `AC-016` and implements `artifact-contract-policy` and `structured-artifact-rendering`. Skills, role prompts, and dynamic prompts use the separate prompt-source contract in `prompt-refinement-method`.

## Chosen Approach

Create a versioned artifact-contract registry. Each profile declares reserved headings, typed fields, required/optional/conditional rules, deterministic trigger predicates, and a renderer. Canonical mutation tools accept profile-specific semantic values. Rendered Markdown remains ordinary, readable, committed text.

Profiles:

### Intent

Required: Problem, Desired Outcome, Scope/Included, Success Signals. Optional: Scope/Excluded, Constraints, Assumptions, Open Questions. Open questions carry authority and disposition; unresolved questions without either block planning submission.

### Specification

Required: Context, Required Behaviors, Acceptance Criteria. Actors is triggered by two or more people, systems, permission classes, or components with distinct behavior. Edge Cases is triggered by declared external input, state transitions, concurrency, persistence, permissions, or failure-prone dependencies. Constraints, Assumptions, Out of Scope, and Open Questions are optional. Acceptance criteria use stable `AC-NNN` IDs unique within the artifact and stable across updates.

### Design

Required: Design Goal, Chosen Approach, Verification Boundaries. Components and Interfaces is triggered by more than one changed component or any consumed/produced public contract. Data and Control Flow is triggered by persisted state, asynchronous events, cross-process communication, or authority transfer. Failure and Recovery is triggered by external dependencies, persistence, retries, interruption, destructive operations, or rollback requirements. Security and Privacy is triggered by credentials, permissions, personal or regulated data, trust-boundary changes, or external communication. Compatibility and Migration is triggered by persisted schema, public interfaces, upgrade behavior, or existing consumers. Alternatives Considered and Open Questions are optional. Specification references use `<artifact-id>#AC-NNN`.

### Decision

Required: Decision, Context, Rationale, Consequences. Alternatives Considered and Revisit When are optional. Consequences are typed as benefit, cost, limitation, or obligation. The artifact ID is the decision ID.

### Task brief

Required: Contribution Goal, Boundary/Included, Required Work, Integration Expectation. Boundary/Excluded, Constraints, and Risks and Uncertainties are optional. Interfaces and Dependencies is triggered by task dependencies, shared resource claims, or any consumed, produced, or modified contract. References, dependency IDs, assignment, workspace, and integration metadata are rendered from `task.yaml`.

### Task acceptance

Required: Deliverables, Criterion Contributions, Boundary Proof. Expected Intermediate State is triggered by `intermediateState: partial`. Integration Proof is triggered when a criterion contribution is declared provable only at integration-unit or work-item timing. Commands remain in structured verification policy rather than being duplicated.

### Evaluation report

Required rendered sections: Boundary, Criteria Evaluated, Observations, Evidence, Findings, Verdict, Residual Risk. Boundary and criterion references come from the evaluation manifest; evidence, findings, and verdict come from the structured terminal handoff. Residual risk means uncertainty or exposure that is not represented as a discrete tracked finding. An explicit empty residual-risk collection renders as `None recorded` because the capability owns that assertion.

### Outcome

Required: Delivered and Verification. Contract Deviations is included when delivered behavior differs from the approved contract. Remaining Findings is generated from unresolved tracked non-blocking findings. Residual Risks is included for accepted uncertainty not represented by a finding. Follow-up is included when explicit future work or user action remains. Empty conditional sections are omitted.

## Components and Interfaces

- A registry maps artifact profile and schema version to field definitions, trigger predicates, validation, and rendering.
- Mutation tools expose discriminated schema-v2 inputs per profile and do not accept raw Markdown for schema-v2 mutation.
- A compatibility reader retains schema-v1 free-form artifacts without asserting conformance.
- `planning_submit` validates all current schema-v2 contract artifacts, unresolved questions, criterion uniqueness, and structured references.
- Task and evaluation manifests gain structured qualified criterion references.
- Evaluator terminal handoff replaces the free-form report with criteria, observations, residual risks, evidence, findings, and verdict fields.
- Completion input supplies delivered items, deviations, residual risks, and follow-up; verification and remaining findings are capability-owned.

## Data and Control Flow

1. A model calls a schema-v2 canonical capability with typed semantic fields.
2. The profile validator rejects empty or placeholder values, invalid identifiers, reserved-heading collisions, and unmet deterministic trigger predicates.
3. Cross-reference validation resolves qualified criteria against schema-v2 specifications in the current work item.
4. The renderer emits headings in registry order and omits absent optional or non-applicable conditional sections.
5. The store acquires the repository mutex for the complete mutation transaction, writes rendered Markdown and associated metadata atomically, advances planning revision when material, and commits once.
6. Readers continue consuming Markdown; capabilities use structured metadata for deterministic checks.

## Failure and Recovery

Validation and rendering complete before mutex-protected file mutation. Errors include profile, field or section, rule, and deterministic trigger. Failed updates preserve prior files, catalogs, planning revision, and Git state. Dirty canonical branches fail before transaction work. Concurrent callers serialize without promising scheduler arrival order. Legacy reads remain available and migration never rewrites committed artifacts automatically.

## Security and Privacy

Renderers preserve user-provided Markdown as text without executing it. Parsers bound input size, ignore headings inside fenced code and HTML comments, and avoid logging secret field values. Security-related triggers report the category that fired, not sensitive content.

## Compatibility and Migration

Introduce schema-v2 typed inputs while retaining schema-v1 reads and approved lifecycle completion. A material update changes semantic section values, stable criteria, or binding references and requires explicit migration through the canonical capability. Lifecycle-only status changes do not migrate an artifact. Mixed v1/v2 work items are allowed, but schema-v2 task and evaluation criterion references cannot target schema-v1 specifications; migrate the referenced specification first. Tool descriptions identify the active contract version.

## Verification Boundaries

- Registry and renderer unit tests prove all profiles, ordering, omission, placeholder rejection, trigger predicates, stable IDs, and additional-section collision handling.
- Store tests prove pre-mutation failure, transaction rollback, dirty-branch behavior, and legacy reads.
- Traceability tests prove qualified criterion resolution and reject legacy or dangling targets.
- Lifecycle tests prove unresolved-question submission failures, mixed-version rules, and schema-v1 approved completion compatibility.
- Concurrency tests prove full transaction serialization, idempotent replay, no partial commits, and no Git index-lock races.
- E2E proves rendered intent, specification, design, tasks, evaluation report, and outcome remain readable and complete.

## Alternatives Considered

A single universal Markdown template was rejected because artifact purposes differ. Parsing only model-authored Markdown was rejected because it retains avoidable formatting retries. Immediate bulk migration was rejected because it would rewrite approved historical contracts without semantic review. Treating prompt source files as canonical narrative profiles was rejected because prompts need static and behavioral contracts rather than runtime rendering.
