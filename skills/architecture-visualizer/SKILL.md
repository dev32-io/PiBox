---
name: architecture-visualizer
description: Explore a codebase or technical subject and express the findings as a live interactive browser diagram. Use when a user asks to visualize architecture, relationships, control flow, components, or an evolving technical explanation.
compatibility: Requires Node.js and a local web browser.
---

# Architecture Visualizer

Create a visual explanation that evolves with the conversation. You own the analysis and semantic content; the bundled browser owns layout and presentation.

## Workflow

1. Clarify the subject or question the user wants to understand.
2. Launch one or more explorer subagents to gather enough repository evidence to explain it accurately.
3. Write the JSON visual document under `.pibox/visualization/architecture/` (harness-owned, ignored) in the target repository, with a short stable topic name such as `.pibox/visualization/architecture/workflow.json`. Create the directory if needed.
4. Start or reuse the session's backend with `visual_companion`:

```json
{
  "action": "start",
  "visualizer": "architecture",
  "artifactPath": ".pibox/visualization/architecture/workflow.json"
}
```

The tool serves the viewer, returns the URL, and opens it in the browser. Use only this tool to launch the backend; never `node`, `bash`, or the internal server script.
5. Tell the user the diagram is live and continue the conversation.
6. For later questions that benefit from visual clarification, update the same JSON; the open browser rerenders, so do not restart the backend.
7. Call `visual_companion` with `{"action":"stop"}` when the user is finished with visual companions or asks to stop them.

## Authoring Principles

- Express the concepts and relationships most useful to the user's question, not every file.
- Nodes may represent components, people, states, files, decisions, notes, warnings, questions, or anything else. Use `kind` freely; unknown kinds render with a generic fallback.
- Use standalone nodes with `kind: "note"` or `kind: "label"` where prose communicates better than another structural concept.
- Add multiple views when one canvas would overload the explanation.
- Write no coordinates, dimensions, or edge routes; the renderer owns geometry.
- Keep IDs stable across edits so browser context is retained.
- Keep labels concise; put deeper explanation in `description`, `details`, `content`, or metadata.
- Include no secrets.

Read [references/visual-document.md](references/visual-document.md) before authoring the first document. Copy [templates/example.json](templates/example.json) when a starting point helps.
