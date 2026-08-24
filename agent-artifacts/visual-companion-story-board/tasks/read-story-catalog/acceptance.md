# Task Acceptance: Read the canonical story catalog asynchronously

## Deliverables

- Discover healthy and historical stories from agent-artifacts without Git operations, source mutation, or whole-catalog failure.

## Acceptance

- No story filesystem access occurs synchronously
- One malformed or legacy story remains visible and cannot hide healthy stories
- Catalog reads never invoke Git, switch branches, or modify artifacts
- Only lightweight index/intent data is read at catalog time
- Diagnostics contain repository-relative paths only

## Boundary Proof

- Reader tests use temporary canonical trees, spies for forbidden Git/write calls, unchanged checksums, and current legacy fixtures
