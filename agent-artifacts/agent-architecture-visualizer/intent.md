# Intent: Agent-driven interactive architecture visualizer

## Problem

The main agent can explain a codebase in text but lacks a durable visual canvas it can update as the conversation evolves. Existing formats either constrain meaning or let model-authored geometry make layout inconsistent.

## Desired Outcome

Add a reusable skill that explores a codebase, writes a flexible JSON visual document, and opens a locally hosted interactive browser renderer. The renderer owns deterministic layout and automatically refreshes when the main session updates the JSON.

## Scope — Included

- Reusable architecture-visualizer skill with exploration and update guidance.
- Flexible JSON views containing nodes, edges, groups, notes, labels, annotations, content, and open-ended metadata.
- Renderer-owned layout, edge routing, grouping presentation, and visual styling.
- Loopback local server, file watching, and live browser refresh.
- Interactive view selection, layout selection, pan, zoom, fit, selection, and details.

## Success Signals

- The skill can produce and serve a useful visualization in an arbitrary trusted repository.
- The open page rerenders after the main agent updates the artifact during follow-up conversation.
- Unknown semantic kinds, notes, and labels remain expressible without model-authored coordinates or schema rejection.

## Scope — Excluded

- Server-side codebase analysis.
- Formal UML enforcement or a fixed architecture ontology.
- Coordinates or geometry in the agent-authored JSON.
- Browser editing or JSON write-back.
- Remote hosting or collaboration.

## Constraints

- The same JSON, renderer version, and selected presentation must produce stable layout and styling.
- Validation must enforce only rendering necessities and preserve open-ended semantics.
- The server must bind to loopback and serve only the selected artifact and bundled assets.
- Keep the implementation lightweight and avoid framework or backend complexity that is not needed.
