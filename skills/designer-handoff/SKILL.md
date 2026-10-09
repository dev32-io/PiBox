---
name: designer-handoff
description: Deliver or regenerate an approved visual mockup as a lean implementation handoff with one image per independently implementable component, variant, and state. Use when the user asks the designer to deliver, finalize, hand off, or refresh implementation references.
---

# Designer Handoff

Turn the approved current mockup into direct visual implementation references. Images carry appearance; prose carries only what images cannot express.

## Source

The approved prototype is the source of every reference. Capture from it, not production code, and do not simplify or reinterpret its appearance. Use the current prototype directory as `<prototype-root>`, keeping an established location such as `design/prototype/<name>/` or `design/prototypes/<name>/`.

## Produce the References

```text
<prototype-root>/
├── handoff.md
└── handoff/
    ├── static/
    └── recordings/
```

### Capture by script

Generate references with one repeatable script that produces the whole component/state matrix. Prefer, in order:

1. an existing repository capture or rendering script;
2. a temporary script driving the available browser/runtime directly, such as headless Chrome through CDP;
3. an existing project browser library or CLI used non-interactively.

Playwright and browser MCP are not required; use browser MCP only for a state that cannot reasonably be scripted, narrowly.

Keep temporary fixtures and scripts outside the repository unless the user asks to retain them or the repository already owns equivalent capture infrastructure. Capture from local approved prototype assets with deterministic state/timing controls.

### One preview target per file

Produce one cropped static PNG for every approved **component × variant × state** in the mockup. A file contains exactly one independently implementable component instance in one state, the unit an implementer would instantiate in one component preview.

- A button file contains one button; five variants need five files.
- Rest, hover, focus, pressed, destructive, and disabled states need separate files when approved.
- A segmented control is one file because its segments form one component.
- A showcase section, specimen row, comparison group, variant grid, collection, or page is not a component reference.

A showcase may group components for review, but keep each instance individually targetable and capture the component element itself.

### Crop and name

Use stable filenames identifying component, variant, and state:

```text
handoff/static/action-button--primary--rest.png
```

Crop to the component's rendered bounds, keeping only the local background or transparent padding needed to preserve its edge, shadow, focus ring, blur, or material. Exclude showcase headings, descriptions, neighbors, and page chrome.

### Motion

When static references cannot communicate an approved transition, add ordered PNG keyframes under `handoff/recordings/<motion-name>/`, each keeping the one-component boundary (no montage or multi-component recording). A playback file may accompany them; the keyframes are the comparison inputs.

## Keep `handoff.md` Lean

Write only:

1. A brief outcome.
2. The prototype entry point.
3. An exact path and one-line meaning for every static reference and motion sequence.
4. Behavior, accessibility requirements, exceptions, or unresolved blockers the images cannot communicate.

Do not repeat dimensions, colors, spacing, shadows, typography, or styling visible in the prototype or images. Add no metadata file, component manifest, capture schema, or implementation plan. The images are the visual authority.

## Completion

Visually inspect every PNG. Each must show one component instance in one state at one motion point, cropped free of showcase or neighboring content, from the approved prototype; split and recapture any that do not. Done when every approved preview target has its own reference, motion keyframes are likewise isolated, and `handoff.md` points to each exactly.
