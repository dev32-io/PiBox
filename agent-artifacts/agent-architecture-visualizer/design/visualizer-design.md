# Open document and deterministic renderer boundary

## Design Goal

Expand the agent's visual expression without constraining its semantic reasoning or delegating layout quality to model-authored geometry.

## Chosen Approach

- Use a small versioned JSON document with named views and generic visual elements.
- Keep semantic kinds and metadata open-ended, with fallback rendering.
- Exclude geometry from the document and derive layout from stable ordering, topology, group membership, and a webpage-selected presentation.
- Use a lightweight Node loopback server to serve prebuilt assets, validate the selected JSON, watch it, and publish refresh notifications.
- Use a focused interactive graph library and deterministic layout engine without introducing an unnecessary application backend.
- Keep browser presentation state separate from the semantic artifact.

## Verification Boundaries

- Fixture tests cover arbitrary kinds, note-only views, disconnected nodes, groups, multiple views, long content, and invalid references.
- Tests prove normalization and layout inputs are stably ordered.
- Server tests prove loopback behavior, safe file boundaries, valid live refresh, and last-valid fallback.
- Schema/tests prove model-authored geometry is absent or rejected.

## Components and Interfaces

- SKILL.md and references/examples.
- JSON loader, minimal validator, and stable normalizer.
- Node loopback server with file watch and browser notification.
- Prebuilt browser renderer with layout/view controls and element details.
- Repository-local generated JSON artifact owned by the invoking agent session.

## Data and Control Flow

- The skill directs repository exploration and JSON generation.
- The server loads the artifact and serves the latest valid normalized document.
- The browser computes and displays renderer-owned layout.
- The main session edits the JSON after user follow-ups.
- The watcher signals the browser to fetch and rerender the latest valid document.

## Failure and Recovery

- Retain the latest valid document across malformed writes.
- Show parse/reference diagnostics without terminating the server.
- Choose an available loopback port or report an actionable startup error.
- Render unknown semantics generically.

## Security and Privacy

- Bind to 127.0.0.1 by default.
- Serve only bundled assets and the explicitly selected JSON.
- Escape all model-authored content.
- Do not expose arbitrary source-file endpoints.

## Compatibility and Migration

- Pin renderer dependencies and version the structural document contract.
- Keep generated artifacts plain JSON and independent of the target repository stack.
- Allow future semantic vocabulary without schema migration.

## Alternatives Considered

- Model-authored coordinates.
- Strict UML or architecture ontology.
- Server-side code analysis.
- Full application backend or browser authoring environment.
