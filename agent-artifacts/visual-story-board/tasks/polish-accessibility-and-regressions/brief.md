# Task Brief: Polish accessibility, responsive behavior, and Architecture regressions

## Contribution Goal

Close cross-surface accessibility, responsive, visual consistency, and Architecture compatibility gaps on the integrated Visual Companion before whole-branch review and browser E2E.

## Boundary — Included

- Cross-view keyboard navigation, focus order/return, labels, tab semantics, drawer/sheet focus management, and reduced-motion fixes
- Desktop and narrow-viewport layout hardening for catalog, board, documents, reports/evidence, and Architecture details
- Shared token consistency, contrast-sensitive state treatment, non-color status communication, wrapping/overflow, and conservative loading/error visuals
- Architecture graph control, selection/detail, last-valid/live-refresh, viewer-switching, and single-backend regression hardening
- Broad deterministic regression tests and fixture smoke checks that accompany implementation fixes

## Required Work

- 1. Audit the integrated shell, Story Board catalog/workspace/task/document/report/evidence surfaces, and Architecture controls against keyboard-only use, logical focus order, accessible names/roles, focus visibility/return, tab semantics, Escape/close behavior, and reduced-motion preferences; implement fixes in production assets.
- 2. Exercise representative long titles, Markdown, findings, evidence metadata, unknown statuses, loading/degraded/error states, and narrow widths; fix wrapping, scrolling, content containment, sticky/header geometry, three-lane usability, and full-height drawer/sheet behavior without hiding essential controls.
- 3. Verify all shared surfaces use semantic tokens and readable fallbacks, status meaning is text/icon plus color, and stray shared palette values or decorative motion do not bypass the approved design system; implement targeted corrections.
- 4. Re-run Architecture under the shell and fix regressions in direct opening, graph view/layout/group/fit/pan/zoom, node/edge selection and details, last-valid document behavior, live artifact refresh, viewer switching, and narrow details presentation.
- 5. Add deterministic accessibility/asset tests for roles/labels/tab order, focus styles and return contracts, reduced-motion CSS, non-color status text, responsive sheet/layout classes, readable fallbacks, token use, and Architecture interaction APIs.
- 6. Run focused companion/Architecture tests plus the full repository check/test suite; resolve only regressions attributable to this story and leave browser journey evidence to the runtime final E2E evaluator.

## Integration Expectation

Run concurrently with assisted-launcher work from the complete browser base; touch only production UI/Architecture assets and regression tests so the launcher can own fixtures and process control independently.

## Context

- The integrated browser application owns all Story Board states and shared tokens; this task is an implementation-and-regression pass, not a proof-only ticket.
- Approved E2E-005 and E2E-006 require Architecture controls/live refresh, keyboard-only navigation, visible focus, non-color status meaning, readable Markdown, and usable narrow-viewport detail sheets.
- Final E2E will run through the concurrently produced assisted launcher, so this task must keep production routes/assets stable and add deterministic pre-E2E proof for observable contracts.

## Boundary — Excluded

- Assisted launcher API/CLI and fixture repository files owned by the parallel medium task
- Canonical reader/API feature expansion or new product behavior outside the approved story
- Managed evaluation resources or manual replacement of final browser journeys

## Interfaces and Dependencies

- Consumes the integrated production shell, tokens, Story Board browser assets/routes, and Architecture adapter.
- Produces polished production assets and deterministic accessibility/responsive/Architecture regression tests consumed by medium whole-branch review and low-tier final E2E.

## Constraints

- Do not add test-only product behavior or couple production assets to the assisted launcher.
- Preserve stable routes and accessible identifiers required by the approved journeys.
- Do not weaken Markdown/evidence containment, lazy-loading, read-only behavior, or Architecture compatibility to simplify presentation.
- Use full-suite checks only after focused fixes; do not create a verification-only contribution.
