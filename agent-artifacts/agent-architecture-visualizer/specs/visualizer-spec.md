# Interactive visualizer contract

## Context

The visualizer is a frontend translator for agent reasoning. The agent explores and authors meaning; a semantically passive local application renders that meaning consistently and keeps it live during the conversation.

## Required Behaviors

- The skill tells the main session how to explore, create the artifact, start the server, and update the same artifact later.
- A document supports multiple named views with nodes, edges, groups, notes, labels, annotations, explanatory content, and arbitrary metadata.
- No agent-authored element positions, dimensions, or routes are accepted; layout is computed by the renderer.
- Unknown semantic kinds use generic fallbacks.
- The webpage offers deterministic layout and grouping presentations without rewriting JSON.
- The server watches the artifact and notifies open pages after valid changes.
- Invalid transient writes retain the last valid diagram and show actionable diagnostics.
- The browser supports view navigation, pan, zoom, fit, selection, and readable element details.

## Acceptance Criteria

- **AC-001:** Invoking the documented skill flow can create a JSON artifact and start a loopback visualizer for it.
- **AC-002:** Documents with multiple views, arbitrary node kinds, standalone notes or labels, groups, annotations, content, and labeled edges render without coordinates.
- **AC-003:** The same normalized document and selected presentation produce stable renderer-owned placement, routing, and styling.
- **AC-004:** Users can switch supported layout or grouping presentations in the webpage without changing the JSON.
- **AC-005:** A valid file update appears in an already-open browser without restarting the server.
- **AC-006:** Unknown semantic kinds and extra metadata render through safe generic fallbacks.
- **AC-007:** The page provides multiple-view navigation, pan, zoom, fit, selection, and element details.
- **AC-008:** Malformed JSON, duplicate IDs, and missing edge endpoints produce clear diagnostics while preserving the last valid rendering.
- **AC-009:** Skill guidance explicitly directs the main agent to evolve the same visual artifact during later clarification.
- **AC-010:** The server binds to loopback and does not expose arbitrary repository files.

## Actors

- User asking for visual understanding.
- Main Pi session authoring and refining the JSON.
- Local browser renderer.

## Constraints

- Structural validation covers version/shape, identities, and relationship references but does not validate domain semantics.
- Model-authored text is rendered as inert content, not executable HTML.
- The implementation should use the smallest practical browser stack consistent with deterministic interactive graph rendering.

## Edge Cases

- Note-only and label-only views.
- Disconnected clusters and nested groups.
- Long content.
- An edge endpoint disappears during an update.
- The selected view or element disappears after refresh.
- The file is observed while temporarily incomplete.

## Out of Scope

- Automated repository analysis in the server.
- Persistent drag positioning.
- Formal UML correctness.
- Remote access.
