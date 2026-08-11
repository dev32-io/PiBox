# Task Brief: Typed explorer protocol

## Contribution Goal

Implement mode-aware typed explorer assignments and structured completion validation with bounded protocol nudges and cited handoffs.

## Boundary — Included

- Lookup, map, trace, impact, diagnose, and explain assignment validation.
- Quick, standard, and thorough depth handling and mode-sensitive required output.
- Structured completion, diagnostic evidence, explain handoff, protocol nudge, and visible protocol failure.

## Required Work

- Validate typed assignment fields before launch.
- Require precise repository citations and mode-appropriate evidence without weakening depth-independent citation requirements.
- Use the shared coordinator and preserve explorer read-only scope.

## Integration Expectation

Integrates as the explorer-protocol unit after prompt-contracts and launch-coordinator; exposes typed assignment and completion contracts to direct exploration and final E2E.

## Boundary — Excluded

- Generic child registry and process-attempt mechanics.
- Canonical planning mutation and product-direction decisions.

## Interfaces and Dependencies

Depends on product-partner-prompt-contracts for explorer role guidance and on file-backed-launch-coordinator for shared launch, handoff, and protocol-attempt mechanics; consumes the registry indirectly through the coordinator.

## Constraints

- Explorer never mutates files or chooses product direction.
- Persistent invalid completion is a protocol failure, not generic prose.
