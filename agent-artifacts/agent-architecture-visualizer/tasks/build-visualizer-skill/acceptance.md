# Task Acceptance: Build the reusable visualizer skill and live renderer

## Deliverables

- A complete architecture-visualizer skill directory with scripts, bundled browser assets, contract documentation, fixtures, and tests.
- Any minimal package configuration and pinned dependencies needed by the renderer.

## Criterion Contributions

- **Criteria:** ["visualizer-spec#AC-001","visualizer-spec#AC-002","visualizer-spec#AC-003","visualizer-spec#AC-004","visualizer-spec#AC-005"]; **Contribution:** Implements the end-to-end skill, document, deterministic renderer, presentation controls, and live update loop.
- **Criteria:** ["visualizer-spec#AC-006","visualizer-spec#AC-007","visualizer-spec#AC-008","visualizer-spec#AC-009","visualizer-spec#AC-010"]; **Contribution:** Implements generic fallbacks, interaction, diagnostics, conversational guidance, and safe loopback serving.

## Boundary Proof

- Tests reject geometry fields but accept arbitrary semantic metadata.
- Server tests show only bundled resources and the selected artifact are reachable.
- Fixtures demonstrate non-architecture notes and labels alongside connected nodes.

## Expected Intermediate State

The feature is complete and directly usable after this single stage.

## Integration Proof

- All repository checks pass.
- A representative JSON fixture opens and refreshes in the browser.
