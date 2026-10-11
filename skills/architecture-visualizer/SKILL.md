---
name: architecture-visualizer
description: Explore a codebase or technical subject through evidence-backed, live architecture views. Use when a user asks to visualize responsibilities, boundaries, relationships, control flow, or an evolving technical explanation.
compatibility: Requires the PiBox visual_companion architecture integration and a local browser; browser image capture is required for visual verification.
---

# Architecture Visualizer

Explain the user's question, not the repository tree. Establish audience, scope, and what arrows mean before selecting elements; infer these when clear, otherwise ask only what changes the explanation. Trace relevant code entry points, responsibilities, state ownership, and interactions. Visibly distinguish current implementation, inferred interpretation, and proposed design.

Read [references/visual-document.md](references/visual-document.md) before first authoring. Use [templates/example.c4](templates/example.c4) as an illustrative syntax starter, not evidence about PiBox.

Author one self-contained native LikeC4 `.c4` file under `.pibox/visualization/architecture/` in the target repository, with a stable topic name. Share model identities across purpose-specific overview and drilldown views. Use actual containment, concise labels, and useful descriptions; the renderer owns geometry. Write no coordinates, dimensions, or edge routes. The companion supplies the dark PiBox theme; do not build a separate presentation layer.

## Live lifecycle

Create the artifact before opening it. Start or reuse the session's companion only through `visual_companion`:

```json
{
  "action": "start",
  "visualizer": "architecture",
  "artifactPath": ".pibox/visualization/architecture/order-flow.c4"
}
```

Use the returned URL. Never launch through `node`, `bash`, internal server scripts, or a LikeC4 CLI/dev server; do not add tools or MCP servers. This integration uses native LikeC4 1.59.4 `fromSource`/WASM, not workspace configs, multiple source files, or JSON conversion. Preserve legacy artifacts; reauthor relevant meaning in `.c4` rather than renaming JSON.

Update the same file during discussion; ordinary edits refresh the open viewer without restarting. Keep element and view IDs stable. Stop only through `visual_companion` with `{"action":"stop"}` when the user is finished with visual companions or asks to stop them.

## Verify the explanation

Before claiming visual verification, inspect actual browser screenshots of the delivered overview and each drilldown used in the explanation at the intended viewport. Match captures to the browser's source revision marker and selected view. Exercise navigation and same-file edits when used. Native drilldown uses node selection and the revealed **Navigate to view** control; do not promise that clicking the node body automatically navigates.

Follow the reference's bounded inspection loop. Parse success, a URL, and a DOM snapshot are not visual proof. If capture or revision matching is unavailable, report visual verification as incomplete, not readability as proven. Deliver the live artifact path/URL, inspected views and revisions, and material limitations.
