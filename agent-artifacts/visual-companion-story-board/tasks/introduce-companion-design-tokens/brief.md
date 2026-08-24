# Task Brief: Introduce shared Visual Companion design tokens

## Contribution Goal

Establish one semantic neutral design-token source and base component layer for every companion viewer.

## Boundary — Included

- Shared tokens.css and base/reset styles served from one common route
- Approved color, gradient, typography, spacing, radius, border, elevation, motion, focus, and geometry tokens
- Shell loading, empty, degraded, and error primitives
- Static/computed-style tests that prevent shared palette drift

## Required Work

- 1. Add one shared CSS token asset with the approved exact graphite, text, accent, success, warning, danger, and information values plus restrained gradients.
- 2. Define the approved typography, 4px spacing scale, 4/6/8/12px radii, one-pixel borders, restrained elevation, 120/160ms motion, reduced-motion behavior, 68px header, 1180px content, 288px lane, and 464px drawer geometry.
- 3. Add semantic component aliases and base styles for canvas, surfaces, text, links, buttons, tabs, badges, focus rings, loading, empty, degraded, and error states.
- 4. Migrate shell styles to semantic variables with conservative fallbacks and no component-local shared hex values.
- 5. Add static and computed-style tests for representative tokens, focus, reduced motion, and shell consumption.
- 6. Document in code that viewer-specific layout may extend tokens but may not create another palette for shared concepts.

## Integration Expectation

Deliver this contribution for integration in stage visual-companion-story-board-delivery.

## Context

- The approved palette uses graphite surfaces, restrained blue interaction, semantic status colors, compact radii, border-led hierarchy, and minimal motion.
- Shell, future Story Board UI, Markdown, and Cytoscape must not maintain separate shared palettes.
- This contribution owns token definitions and shell/base primitives; Architecture graph migration follows separately.

## Boundary — Excluded

- Architecture graph token mapping
- Story Board cards, accordions, reports, and drawers
- Runtime theme switching or light theme

## Interfaces and Dependencies

- Consumes the backend common-asset route and shell class names.
- Produces stable CSS custom properties and base primitives consumed by Architecture and Story Board tasks.
