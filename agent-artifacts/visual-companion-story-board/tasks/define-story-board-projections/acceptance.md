# Task Acceptance: Define pure Story Board projection contracts

## Deliverables

- Create explicit browser-safe models and deterministic mapping rules before filesystem or HTTP behavior is introduced.

## Acceptance

- Every persisted task status maps deterministically to exactly one traditional column and remains visible as exact text
- Story and document ordering is deterministic
- Reports remain independent objects with optional task links
- Projected values contain no absolute paths, functions, or workflow mutation handles

## Boundary Proof

- Pure unit tests enumerate task statuses and representative healthy/degraded projection inputs
