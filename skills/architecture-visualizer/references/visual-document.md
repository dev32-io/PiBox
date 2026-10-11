# Native architecture document

## Meaning before layout

Give each view a short title and description explaining its question, audience, scope, and arrow meaning. Model logical responsibilities, not one node per directory, unless files/imports are the question. Imports alone do not prove runtime calls.

Define native `specification`, `model`, and `views` in one file. Declare element kinds in `specification`; define elements and relationships once in `model`; select those shared identities in `views`. Keep IDs stable across edits. Start with an overview and add a scoped drilldown only when it answers a different question. Preserve relevant external collaborators. There is no universal box count: choose enough detail to explain the path without making the overview unreadable.

Nesting asserts “part of,” not deployment, ownership, or navigation. A native view `group` is a visual grouping for a discussion concern, not model containment. Name the boundary's meaning; do not invent nested systems to improve placement.

Use short identifying titles and responsibility descriptions. Label directed relationships with specific verbs; distinguish calls, events, reads, and writes where relevant. Put evidence, technology, and failure detail in descriptions or metadata rather than long edge labels. Review aggregated overview edges against their underlying relationships; do not imply a new interaction merely because the renderer summarizes several.

## Small native example

[templates/example.c4](../templates/example.c4) (relative to this reference) is a complete **ILLUSTRATIVE** user/app/API/worker/store model, not a current PiBox architecture claim. Copy it into the repository artifact directory and replace its fictional semantics with inspected evidence.

Its key selection pattern is:

```c4
views {
  view index {
    title 'ILLUSTRATIVE — who accepts work?'
    description 'For maintainers. Arrows show labeled interactions; App contains the processing components.'
    include user
    include app with { navigateTo processing }
    autoLayout LeftRight
  }
  view processing of app {
    title 'ILLUSTRATIVE — how is work processed?'
    description 'For maintainers. Arrows show requests, dispatch, and writes inside the logical App boundary.'
    include user, app, app.*
    autoLayout TopBottom
  }
}
```

A named `view processing of app` establishes scope; it does not by itself guarantee the parent boundary is drawn. Explicitly include `app` alongside `app.*` for visible containment. The overview includes the collapsed parent; `navigateTo processing` points to the named drilldown. Select the intended view in the browser, then select the node and use its revealed navigation control. Verify the destination and return to the overview; do not assume a node-body click navigates.

## Exploration and scenarios

Use native search to locate elements/views and focus or relationship browsing to inspect relevant connections without expanding everything onto one canvas. These controls help exploration; they do not make an overloaded overview readable.

For a question about execution order, author a `dynamic view` using the same model identities. The template's `request` view demonstrates ordered interactions. Walkthrough controls step through that authored scenario; they are not runtime tracing or simulation. Keep scenario claims evidence-backed and verify Next/Previous highlights the intended interactions.

**Save screenshot** saves the current diagram viewport, including its current pan/zoom and visible state—not off-screen content or every view. Inspect the downloaded image before sharing it. No export CLI or separate capture service is needed.

## Evidence and claim status

Trace claims to inspected code paths and symbols. Use native element or relationship metadata for provenance; this is an authoring convention, not a PiBox schema:

```c4
metadata {
  claim 'current'
  source 'repository/path.ts: symbolName'
}
```

`current` means verified implementation; `inferred` means interpretation with supporting evidence and uncertainty explained; `proposed` means desired behavior, not implementation. Make status visible in view titles/descriptions and, for mixed views, affected element/relationship titles or descriptions. Metadata alone is not a visible status label. Prefer separate current/proposed views when mixing would mislead.

Use native `description` for readable detail and `metadata` for source paths, symbols, and useful commit identity. Inspect the selected element's detail presentation before relying on it; do not assume source metadata becomes a clickable link. Include no secrets or remote images/icons that could leak context or require network access. No workspace configuration or external source files are needed.

## Inspect the rendered explanation

1. Check companion diagnostics. Open the returned URL with an available browser tool, select the intended view, and wait for text, fonts, and geometry to settle. Compilation success proves syntax/layout generation, not readability.
2. Capture and actually inspect the image. Record artifact path, source revision/hash, selected view ID, viewport, and screenshot location with the result. Match the browser's revision/view marker to the edited source and confirm the expected content is rendered. A local hash alone does not prove browser freshness.
3. At the intended reading size, can the audience identify the responsible component, trace the relevant interaction, and interpret the boundary? Inspect labels, arrow endpoints, clipping, overlaps, and contrast in the dark PiBox theme. An overview needing corrective zoom/pan is not yet a readable overview. Inspect drilldown navigation and return as well as its destination image.
4. After same-file edits, wait for the new revision and recapture affected views. Invalid edits show diagnostics while retaining the last valid model: that older image is not proof of the latest source. Resolve diagnostics and verify the new revision before claiming the update passed.
5. Fix the observed obstacle with clearer labels, a purposeful subset, separate views, or native `autoLayout LeftRight`/`TopBottom` intent. Do not erase important coupling for a prettier image or author manual geometry. Allow at most two targeted repair-and-recapture rounds per delivery attempt; stop earlier if blocked or improvement stalls and report remaining defects.

If screenshot capture, view selection, or revision matching is unsupported, state exactly what was checked and what remains unverified. Do not install a browser service, invoke an export CLI, or start a private backend to fill the gap. General image/vector/batch export remains outside this integration; use the current-view screenshot control when that is sufficient.
