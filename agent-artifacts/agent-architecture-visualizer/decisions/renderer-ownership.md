# Renderer owns geometry; agent owns meaning

## Decision

The visual document contains concepts, content, relationships, grouping inputs, and open-ended metadata, but no coordinates or geometry. The visualizer deterministically computes layout and provides alternate presentations.

## Context

The JSON must remain easy for an agent to author while visual output remains stable and semantic expression remains unrestricted.

## Rationale

Separating meaning from geometry keeps model edits robust, makes renderer behavior repeatable, and permits arbitrary notes, labels, and novel concepts through generic fallbacks.

## Consequences

- Layout quality is a renderer responsibility.
- Dragging may be ephemeral but is not persisted.
- Grouping can influence layout without specifying group geometry.
- The renderer must handle sparse, dense, disconnected, grouped, and note-only documents.

## Alternatives Considered

- Absolute or suggested positions.
- A fixed component vocabulary.
- Formal UML as the source language.
