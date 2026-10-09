# Visual Document

The format is small and permissive: what the renderer needs to draw, not an architecture ontology.

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

Positions, sizes, coordinates, and routes are ignored; the renderer owns layout.

## Standalone annotations

Annotations use the same shape as nodes and participate in automatic layout:

```json
{
  "id": "warning",
  "kind": "note",
  "text": "Retries can produce another attempt."
}
```

Use `annotations` for explanatory canvas content distinct from domain concepts; a regular node with `kind: "note"` or `"label"` also works.

## Groups

```json
{
  "id": "application",
  "label": "Application"
}
```

A node joins a group with `"group": "application"`. Group membership influences renderer-owned layout.

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

Edges may carry any `kind` and additional fields; the renderer does not validate them as architecture.

## Multiple views

Views are independent canvases and may reuse IDs. Useful divisions: overview/detail, static/runtime, communication/control-flow, current/desired.

## Lightweight validation

The server checks only:

- the document is an object and `views` is an array;
- views and drawable elements have non-empty IDs;
- IDs are unique within each view;
- edges reference nodes or annotations in the same view;
- known collections are arrays when present.

Unknown semantic kinds, metadata, and extra fields are accepted.
