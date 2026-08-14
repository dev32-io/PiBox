# Task Brief: Build the reusable visualizer skill and live renderer

## Contribution Goal

Deliver the smallest complete architecture-visualizer skill: an agent-authored JSON contract, deterministic interactive browser renderer, safe local watch server, examples, and tests.

## Boundary — Included

- Create the skill package and progressive instructions.
- Define and document the minimal open JSON contract without geometry.
- Implement stable normalization and minimal structural/reference validation.
- Implement a loopback server that serves bundled assets, watches one artifact, retains the last valid document, and notifies browsers.
- Implement the interactive renderer with deterministic layouts, groups, notes/labels, generic semantic fallbacks, view controls, navigation, and details.
- Add representative fixtures and focused tests.
- Add only the dependencies and build plumbing actually required to ship the renderer.

## Required Work

- Prefer a lightweight implementation over a generalized diagram platform.
- Ensure target repositories do not need their own frontend setup beyond invoking the bundled skill script.
- Make repeated artifact edits update the existing page.
- Document exact invocation and artifact location conventions.

## Integration Expectation

The completed contribution is directly invokable from this package's discovered skills and remains compatible with existing PiBox checks.

## Boundary — Excluded

- Automatic source analysis.
- Browser write-back.
- Remote serving.
- Formal UML validation.
- Persistent manual positioning.

## Interfaces and Dependencies

- Pi skill discovery conventions.
- Node runtime and package distribution through the existing skills entry.
- The visual-document JSON consumed by the local server and browser.

## Constraints

- Do not add model-authored geometry fields.
- Do not reject unknown semantic kinds or metadata.
- Do not expose arbitrary repository files.
- Avoid overengineering, unnecessary framework layers, or premature extension systems.

## Risks and Uncertainties

- Browser assets must be distributable with the package while keeping target setup simple.
- Automatic layout must remain useful for disconnected and grouped content.
