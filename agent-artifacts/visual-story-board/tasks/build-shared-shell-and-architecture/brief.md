# Task Brief: Build the shared shell and migrate Architecture to design tokens

## Contribution Goal

Give Story Board and Architecture one responsive, keyboard-accessible application shell and semantic visual system while preserving Architecture graph behavior and direct opening.

## Boundary — Included

- Shared shell HTML/CSS/browser controller with route-aware Story Board and Architecture navigation
- One common semantic token and base-style asset with conservative readable fallbacks
- Architecture adapter and assets mounted beneath the shell with Cytoscape styles resolved from semantic CSS variables
- Accessible focus, tabs, viewer mount boundaries, responsive shell geometry, and preserved Architecture state/live refresh
- Focused shell, token-consumption, and Architecture regression tests

## Required Work

- 1. Add common shell assets served through the host: persistent header, route-aware Story Board and Architecture tabs, viewer mount regions, local loading/error boundaries, accessible tab semantics, and deep/direct route interpretation.
- 2. Implement the approved semantic token source and base styles for canvas/surfaces/text/accent/status colors, typography, spacing, radii, borders, elevation, motion, focus rings, header/content/lane/drawer geometry, reduced motion, and readable asset-load fallbacks.
- 3. Adapt Architecture HTML and browser startup so it mounts under the shell, remains selected for direct Architecture routes, and retains graph view/layout/group/fit/pan/zoom/selection/details behavior and watcher/SSE live refresh.
- 4. Replace shared hard-coded Architecture palette values with semantic CSS variables; resolve graph-specific Cytoscape colors from computed variables while retaining only explicitly documented visualization mappings.
- 5. Preserve viewer state when switching tabs where practical, keep viewer-local loading isolated, and ensure narrow viewports retain details as an accessible sheet rather than hiding them.
- 6. Add focused static and computed-style contract tests for shell navigation, direct-route selection, common token loading/fallbacks, focus/reduced-motion behavior, absence of stray shared palette literals, and existing Architecture validation/live-refresh interactions.

## Integration Expectation

Integrate the shell and tokenized Architecture surface in parallel with the Story Board API, using only the stable host contract from the foundation stage.

## Context

- The reusable host supplies common assets and viewer selection; Architecture currently renders a standalone page with hard-coded palette values and hides details at narrow widths.
- The shell must expose Story Board and Architecture tabs on user-facing routes, make Story Board the ordinary service home, and honor direct Architecture routes without activating Story Board.
- The approved neutral system defines shared semantic colors, typography, spacing, geometry, elevation, focus, reduced motion, and responsive drawer/sheet behavior.

## Boundary — Excluded

- Story Board canonical readers, API routes, cache, catalog/board/documents/reports rendering, or fixture data
- Service lifecycle refactoring already owned by the platform task
- Final browser E2E evidence collection

## Interfaces and Dependencies

- Consumes the integrated common asset/viewer registration contract and existing Architecture viewer/document APIs.
- Produces stable shell routes, Story Board and Architecture mount points, shared semantic tokens, and a shell-selected Architecture adapter consumed by Story Board browser and assisted-launcher tasks.

## Constraints

- Direct Architecture opening must not initialize or request Story Board data.
- Do not alter Architecture document semantics, validation contract, graph controls, or last-valid/live-refresh behavior.
- Interactive state and status meaning must not rely on color alone; focus must remain visible and reduced motion honored.
- Viewer-specific CSS may add layout but may not establish a second palette for shared concepts.
