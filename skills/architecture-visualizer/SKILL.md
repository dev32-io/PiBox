---
name: architecture-visualizer
description: Explore a codebase or technical subject and express the findings as a live interactive browser diagram. Use when a user asks to visualize architecture, relationships, control flow, components, or an evolving technical explanation.
compatibility: Requires Node.js and a local web browser.
---

# Architecture Visualizer

Create a visual explanation that can evolve with the conversation. You own the analysis and semantic content; the bundled browser owns layout and presentation.

## Workflow

1. Clarify the subject or question the user wants to understand.
2. Launch one or multiple explorer subagents to gather enough repository evidence to explain it accurately.
3. Write the JSON visual document under `.pibox/visualization/architecture/` in the target repository, using a short stable topic name such as `.pibox/visualization/architecture/workflow.json`. Create the directory if needed. Keep visual artifacts in this harness-owned ignored area rather than scattering them through the project tree.
4. Start or reuse the session's managed backend with the `visual_companion` tool:

```json
{
  "action": "start",
  "visualizer": "architecture",
  "artifactPath": ".pibox/visualization/architecture/workflow.json"
}
```

The tool selects a random loopback port, serves the architecture viewer through the session's single visual-companion backend, returns the URL, and opens it in the browser. Always use this tool; never launch the backend manually through `node`, `bash`, or the internal server script.
5. Tell the user the diagram is live. Continue the conversation normally.
6. When later questions benefit from visual clarification, update the same JSON. The open browser rerenders automatically; do not restart the backend.
7. Call `visual_companion` with `{"action":"stop"}` when the user is finished with visual companions or explicitly asks to stop them.

## Authoring Principles

- Express the concepts and relationships most useful to the user's question, not every file in the repository.
- Treat the document as an open visual canvas. Nodes may represent components, people, states, files, decisions, notes, warnings, questions, or anything else.
- Use `kind` freely. Unknown kinds render with a generic fallback.
- Use standalone nodes with `kind: "note"` or `kind: "label"` whenever prose on the canvas communicates better than another structural concept.
- Add multiple views when one canvas would overload the explanation.
- Do not write coordinates, dimensions, or edge routes. The renderer owns geometry.
- Keep IDs stable across conversational edits so browser context can be retained.
- Prefer concise labels and place deeper explanation in `description`, `details`, `content`, or arbitrary metadata.
- Never include secrets merely to make the diagram complete.

Read [references/visual-document.md](references/visual-document.md) before authoring the first document. Copy [templates/example.json](templates/example.json) when a starting point helps.

The backend module is an internal implementation detail of the `visual_companion` extension. Do not invoke or manage it directly from this skill.
