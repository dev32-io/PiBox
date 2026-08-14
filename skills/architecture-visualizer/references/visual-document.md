# Visual Document

The format is deliberately small and permissive. It defines what the renderer needs to draw, not an ontology for architecture.

## Document

```json
{
  "version": 1,
  "title": "Readable title",
  "description": "Optional short explanation",
  "views": []
}
```

Only `views` must be an array. Extra document fields are allowed.

## View

```json
{
  "id": "overview",
  "title": "Overview",
  "description": "Optional view explanation",
  "groups": [],
  "nodes": [],
  "annotations": [],
  "edges": []
}
```

A view needs a stable string `id`. All collections are optional and default to empty arrays.

## Nodes

```json
{
  "id": "api",
  "label": "Public API",
  "kind": "service",
  "description": "Receives client requests",
  "group": "application",
  "content": ["Routes requests", "Returns responses"],
  "metadata": { "owner": "platform" }
}
```

A node needs only `id`. Its visible label falls back through `label`, `title`, `name`, `text`, then `id`.

`kind` is open-ended. The renderer has small visual conveniences for `note`, `label`, `actor`, `decision`, and `database`; every other value uses a generic component style. Arbitrary additional fields are shown in the details panel.

Do not add positions, sizes, coordinates, or routes. Such fields are ignored because layout belongs to the renderer.

## Standalone annotations

Annotations use the same shape as nodes and participate in automatic layout:

```json
{
  "id": "warning",
  "kind": "note",
  "text": "Retries can produce another attempt."
}
```

Use `annotations` to distinguish explanatory canvas content from domain concepts. Using a regular node with `kind: "note"` or `kind: "label"` is also valid.

## Groups

```json
{
  "id": "application",
  "label": "Application"
}
```

A node joins a group with `"group": "application"`. Group membership influences renderer-owned layout. The webpage can hide grouping without changing the document.

## Edges

```json
{
  "id": "api-to-store",
  "source": "api",
  "target": "store",
  "label": "reads and writes",
  "kind": "data-flow",
  "details": "Validated records only"
}
```

`from` and `to` are accepted aliases for `source` and `target`. An edge needs valid endpoints. Its `id` is optional; the renderer derives one deterministically when omitted.

Relationships may carry any semantic `kind` and arbitrary additional information. The renderer does not judge whether a relationship is valid architecture or UML.

## Multiple views

Views are independent canvases and may reuse the same IDs. Useful divisions include overview/detail, static/runtime, communication/control-flow, or current/desired behavior, but the agent may choose any framing helpful to the user.

## Lightweight validation

The server checks only:

- the document is an object and `views` is an array;
- views and drawable elements have non-empty IDs;
- IDs are unique within each view;
- edges reference nodes or annotations in the same view;
- known collections are arrays when present.

Unknown semantic kinds, metadata, and extra fields are accepted.
