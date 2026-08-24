# Task Brief: Add the shared companion shell and viewer navigation

## Contribution Goal

Serve an immediately interactive application shell with Story Board and Architecture destinations before either viewer loads content.

## Boundary — Included

- Shared shell HTML, JavaScript, and baseline layout assets
- Top-level tab semantics and viewer-local mount regions
- Root, Story Board, Architecture, and refreshable deep-route handling
- Contained loading, empty, and error mount states without Story Board data access

## Required Work

- 1. Add shell assets under the Visual Companion extension and expose them through the backend common-route contract.
- 2. Implement accessible Story Board and Architecture tabs, active state, keyboard activation, viewer-local content regions, and route parsing without loading Story Board data.
- 3. Make the root route select Story Board after the shell has rendered; make direct Architecture routes select Architecture without touching Story Board activation hooks.
- 4. Preserve refreshable local URLs and route fallback for unknown shell paths without exposing filesystem paths.
- 5. Add focused server/DOM-light tests proving shell-first serving, route selection, tab semantics, and zero Story Board discovery calls.
- 6. Keep styling deliberately structural; the next design-token task owns the final palette.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- The generalized backend from the prior sequential contribution can expose common assets and non-artifact viewer routes.
- The shell must be available without scanning agent-artifacts and must remain interactive while a viewer loads.
- All user-facing routes need persistent Story Board and Architecture tabs, with Story Board as ordinary home and Architecture selectable directly.

## Boundary — Excluded

- Service registry start/status/stop wiring
- Story catalog APIs or cards
- Architecture graph mounting or visual migration
- Final responsive polish

## Interfaces and Dependencies

- Consumes the backend common-asset and viewer-destination contract.
- Produces shell routes, tab events, and viewer activation hooks that lifecycle and viewer tasks can call.
