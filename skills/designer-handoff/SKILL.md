---
name: designer-handoff
description: Deliver or regenerate an approved visual mockup as a lean implementation handoff with one image per independently implementable component, variant, and state. Use when the user asks the designer to deliver, finalize, hand off, or refresh implementation references.
---

# Designer Handoff

Turn the approved current mockup into direct visual implementation references. Let the images carry appearance; keep prose limited to information the images cannot express.

## Preserve Authority

- Preserve the approved prototype as the source of every reference.
- Do not capture references from production implementation code.
- Do not simplify or reinterpret the approved appearance while preparing the handoff.
- Use the current prototype directory as `<prototype-root>`, preserving an established repository location such as `design/prototype/<name>/` or `design/prototypes/<name>/`.

## Produce the References

Create:

```text
<prototype-root>/
├── handoff.md
└── handoff/
    ├── static/
    └── recordings/
```

### Prefer scripted batch capture

Generate references with a repeatable script or command whenever possible. Prefer, in order:

1. an existing repository capture or rendering script;
2. a temporary script that drives the available browser/runtime directly, such as headless Chrome through CDP, and generates the complete component/state matrix in one execution;
3. an existing project browser library or CLI used non-interactively from a script.

A browser renderer may still be necessary for faithful HTML/CSS output, but Playwright and browser MCP are not requirements. Prefer one scripted batch over repeated agent-driven browser calls. Use browser MCP only for a reference or state that cannot reasonably be generated or captured through the available script/runtime path, and keep that fallback narrowly scoped.

Keep temporary capture fixtures and scripts outside the repository unless the user asks to retain them or the repository already owns equivalent capture infrastructure. Capture from local approved prototype assets, preserve deterministic state/timing controls, and visually inspect the generated files after the script completes.

### One preview target per file

Produce one cropped static PNG for every approved **component × variant × state** represented by the current mockup.

A reference file must contain exactly one independently implementable component instance in exactly one state. The component boundary is the unit an implementer would instantiate and render in one component preview.

- A button reference contains one button only.
- Five button variants require five separate files.
- Rest, hover, focus, pressed, destructive, and disabled states require separate files when approved.
- A segmented control may remain one file because its segments together form one component.
- A showcase section, specimen row, comparison group, variant grid, collection, or page is not a component reference.

A showcase may group components for user review, but keep each component instance individually targetable and capture the component element itself. Showcase grouping must never become the handoff capture boundary.

### Crop and name clearly

Use stable filenames that identify component, applicable variant, and state:

```text
handoff/static/action-button--primary--rest.png
handoff/static/action-button--primary--pressed.png
handoff/static/action-button--secondary--rest.png
```

Crop to the component's rendered bounds. Retain only the minimal local background or transparent padding needed to preserve its edge, shadow, focus ring, blur, or material. Exclude showcase headings, descriptions, neighboring examples, and unrelated page chrome.

### Record motion only when needed

When static references cannot communicate an approved transition or motion, create ordered PNG keyframes under:

```text
handoff/recordings/<motion-name>/
```

Each keyframe must preserve the same one-component boundary. Do not use a montage, specimen row, or multi-component recording as the implementation reference. A playback file may accompany the keyframes when useful, but the PNG keyframes are the comparison inputs.

## Verify Before Delivery

Inspect every generated PNG before finishing.

For each file, verify:

- it contains one component instance;
- it contains one state at one motion point;
- its crop excludes showcase or neighboring content;
- its appearance comes from the approved prototype;
- it corresponds to one sensible implementation preview target.

If any image contains multiple component instances or multiple states, split and recapture it. Do not deliver grouped references.

## Keep `handoff.md` Lean

Write only:

1. A brief outcome.
2. The prototype entry point.
3. An exact path and one-line meaning for every static reference and motion sequence.
4. Behavior, accessibility requirements, exceptions, or unresolved blockers that the images cannot communicate.

Do not repeat dimensions, colors, spacing, shadows, typography, or styling visible in the prototype source or rendered references. Do not add a metadata file, component manifest, capture schema, or implementation plan.

The rendered references are the visual authority. When in doubt, inspect the referenced image rather than inferring appearance from prose.

## Completion

A handoff is complete only when every approved implementation-preview target has its own per-state reference, optional motion keyframes are similarly isolated, every file has been visually inspected, and `handoff.md` points to each reference exactly.
