# Task Brief: Mount Architecture in the shell and migrate its visual system

## Contribution Goal

Run the existing Architecture viewer inside the shared shell using semantic design tokens without regressing graph behavior.

## Boundary — Included

- Shell-mountable Architecture DOM and browser module
- Semantic token mapping for graph nodes, edges, groups, selection, actors, decisions, data, warnings, and labels
- Architecture detail behavior at narrow widths
- Regression tests for existing controls and live refresh

## Required Work

- 1. Refactor Architecture HTML/JavaScript into a shell-mountable viewer while retaining a compatibility page for createVisualizerServer and legacy direct routes.
- 2. Scope DOM lookups and teardown so switching viewers does not duplicate listeners, Cytoscape instances, SSE clients, or stale selection details.
- 3. Replace CSS palette literals with shared semantic variables and make Cytoscape read resolved CSS variables through getComputedStyle.
- 4. Preserve view/layout selection, group toggle, fit, pan/zoom, node/edge detail selection, last-valid diagnostics, and SSE artifact refresh.
- 5. Replace the narrow-screen hidden details panel with a usable responsive details sheet compatible with later shared drawer behavior.
- 6. Extend Architecture tests and browser-light fixtures for mounting, unmounting, token consumption, state preservation, live refresh, and legacy server compatibility.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- Architecture assets currently own a complete page, query global element IDs, hide details below 820px, and hard-code colors in CSS and Cytoscape JavaScript.
- Its adapter, validation, /api/document, /events, vendor route, watcher, and createVisualizerServer compatibility must remain intact.
- Cytoscape must resolve shared CSS variables through computed styles rather than receive a duplicate token object.

## Boundary — Excluded

- Story Board data or UI
- Changes to architecture document schema or normalization
- New graph layouts or editing controls

## Interfaces and Dependencies

- Consumes shell viewer activation hooks, shared tokens, and the preserved Architecture backend APIs.
- Produces a mount/unmount Architecture viewer module and compatibility page using the same graph adapter.
