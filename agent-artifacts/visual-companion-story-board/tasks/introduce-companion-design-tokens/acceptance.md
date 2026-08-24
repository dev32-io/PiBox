# Task Acceptance: Introduce shared Visual Companion design tokens

## Deliverables

- Establish one semantic neutral design-token source and base component layer for every companion viewer.

## Acceptance

- One shared token asset contains the approved visual system values
- Shell components consume semantic variables rather than the previous visualizer palette
- Focus and status semantics do not rely on color alone
- Reduced-motion and fallback styles preserve readability

## Boundary Proof

- Token and shell style tests verify exact variables and forbid undocumented shared palette literals outside the token source
