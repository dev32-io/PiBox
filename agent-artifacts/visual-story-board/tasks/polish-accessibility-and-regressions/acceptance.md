# Task Acceptance: Polish accessibility, responsive behavior, and Architecture regressions

## Deliverables

- Close cross-surface accessibility, responsive, visual consistency, and Architecture compatibility gaps on the integrated Visual Companion before whole-branch review and browser E2E.

## Acceptance

- Keyboard users can reach and activate tabs, stories, local views, task cards, accordions, report items, drawer/sheet controls, and Refresh with visible focus and logical return.
- Narrow viewports retain readable catalog, board, documents/reports Markdown, and full-height task/report details without hidden essential controls.
- Statuses remain understandable without color and shared surfaces consistently use semantic tokens, restrained motion, and readable fallbacks.
- Architecture remains fully functional under the shell across direct opening, controls, details, live refresh, and viewer switching.
- Focused and full deterministic checks pass before final whole-branch review and E2E.

## Boundary Proof

- Accessibility, responsive, token, and Architecture regression tests exercise production assets and observable contracts; full npm tests guard unrelated repository behavior before runtime browser journeys.
