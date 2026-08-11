# Task Acceptance: Managed lifecycle migration and recovery

## Deliverables

- All model-backed managed paths use the shared coordinator; resume reconciliation handles live, reported, interrupted, and identity-ambiguous children; durable blocking response and later attempt work.
- Existing managed lifecycle and compatibility behavior remains valid.

## Criterion Contributions

- product-partner-and-subagent-lifecycle#AC-008
- product-partner-and-subagent-lifecycle#AC-011
- product-partner-and-subagent-lifecycle#AC-012
- product-partner-and-subagent-lifecycle#AC-013
- product-partner-and-subagent-lifecycle#AC-014
- product-partner-and-subagent-lifecycle#AC-016

## Boundary Proof

Final E2E launches explorer and task children, exits main, records handoff and blocking request, resumes the same session, responds, reconciles, evaluates, and completes without duplicate writers or lost messages.

## Expected Intermediate State

Complete only when all prior integration units are available and canonical lifecycle gates remain intact.

## Integration Proof

Required final background-resume lifecycle E2E, lifecycle regression, approval/worktree recovery checks, schema-v1 compatibility checks, and canonical artifact protection checks pass.
