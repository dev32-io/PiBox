---
name: mockup-to-implementation
description: Translate or refine a requested production component or product slice from an approved repository HTML/CSS/JavaScript mockup into idiomatic React or Preact, SwiftUI, or Jetpack Compose code.
---

# Mockup to Implementation

Preserve the approved mockup's appearance and behavior through platform-native architecture, not reconstructed screenshots or mechanically copied web details.

## Authority

- The requested component, state, or product slice is the scope boundary.
- The approved HTML, CSS, JavaScript, and linked assets are the authority for structure, behavior, responsive rules, layering, and motion.
- Handoff images are the visual authority for appearance; otherwise use the rendered approved mockup. Visual diffs are diagnostic only.
- The target repository's instructions, design system, shared-component architecture, and platform conventions are the implementation authority.
- When refining an existing production component, preserve its working behavior and public API unless the request changes them.
- On conflict, inspect the relevant source and render. Stop and report a conflict that changes requested behavior, public contracts, or architecture; document smaller platform adaptations.

## Working Protocol

### 1. Understand both codebases before editing

Explore the relevant source and target paths before the first production edit.

For the mockup slice, trace:

- the handoff, readme docs, and `DESIGN.md`;
- its exact HTML boundary, semantics, content, variants, and states;
- every relevant CSS rule, variable, pseudo-element, responsive query, keyframe, asset, inherited style, layout constraint, and stacking relationship;
- the JavaScript owning events, state transitions, DOM updates, timing, interruption, and reduced-motion behavior.

In the target:

- read the closest repository instructions and platform/build configuration;
- inspect design-system entry points, themes, tokens, shared components, primitives, styles or modifiers, representative call sites, and test or preview patterns;
- trace actual implementations and consumers rather than inferring from names.

Before the first edit, keep working notes mapping source behavior and visual recipes to existing target components, primitives, or tokens, marking each concern **reuse**, **extend**, **new local**, or **platform adaptation** with a short reason. Create no repository artifact unless requested.

### 2. Build through the shared design system

Prefer, in order:

1. an existing shared component whose semantics and behavior fit;
2. composition from existing shared primitives and semantic tokens;
3. a small extension to the existing component or design-system layer;
4. a local implementation when the design is specific to the slice or reuse would change another component's semantics or behavior.

Search component indexes, token definitions, sibling implementations, and repeated values before declaring anything new, including semantic equivalents under another name. A missing shared abstraction does not justify local hardcoding.

Extract the smallest shared token or primitive when there is concrete evidence it belongs in the shared layer: it repeats in the target, the mockup defines it as design language, or the component family shares it (surfaces, fills, borders, shadows, glows, typography, spacing, shapes, interaction treatments, motion recipes). Place it in the established design-system layer with a semantic name and update only the immediate consumers. Add no speculative API, universal component, framework, or token for an unexplained one-off adjustment.

### 3. Translate intent into platform-native code

- Preserve meaning, content hierarchy, state ownership, actions, accessibility, adaptive behavior, layering, and motion intent.
- Translate browser mechanisms into target-platform mechanisms; do not copy presentation-only DOM wrappers, CSS coordinates, browser breakpoints, or unsupported interaction states literally.
- Keep one source of truth for state and derive visual and accessibility state from it.
- Prefer native controls and established repository components, styled or composed faithfully.
- Keep product-specific composition local; promote proven reusable design language to the shared layer.
- Inspect how source effects are constructed rather than approximating them roughly.

### 4. Verify and refine

- Run the target's focused build, type, behavior, preview, and accessibility checks. Exercise every requested state and relevant responsive or adaptive configuration.
- For each visual correction, re-read the responsible source and fix the target-platform mapping causing the difference, not an unrelated offset that happens to reduce a score.
- Visual-diff measurements are diagnostic across different renderers, never the sole completion target. Prioritize the meaningful differences and ignore minor ones from text rasterization, anti-aliasing, or platform rendering.
- If about to add a magic constant, no-op modifier, impossible platform state, test-only production branch, or a second unexplained pixel nudge to the same element, stop. Re-derive from the source and shared primitives, or report the native difference; do not try another offset.
- Report deliberate platform differences kept for correct native rendering, accessibility, or adaptive behavior.

## Platform Protocols

Apply only the subsection matching the target repository; if none matches, report the mismatch.

### React or Preact

- When the target reuses mockup CSS, keep the minimum semantic DOM shape and class relationships its selectors require. Otherwise translate styles into the target CSS architecture and drop presentation-only wrappers.
- Keep presentation, responsive layout, pseudo-states, and visual animation in CSS; component state selects classes, attributes, and custom properties rather than writing per-frame visual values from JavaScript.
- Keep React or Preact the single owner of rendered DOM; keep state at the smallest owner.
- Use effects only to synchronize with external systems, and clean up listeners, observers, timers, and animation loops. Derive render values instead of mirroring them through effects.
- Prefer native HTML controls and preserve keyboard behavior, focus order, accessible names, and visible focus; use full ARIA behavior only when native HTML cannot express the control.
- Follow the project's React, Preact, or compat conventions exactly; their event and runtime behavior is not interchangeable.

### iOS SwiftUI

- Prefer native controls with custom `ButtonStyle`, `ToggleStyle`, and repository conventions so activation, focus, disabled behavior, and accessibility stay correct.
- Keep local transient state at the smallest owner; pass bindings only when a child must mutate parent-owned state. Follow the repository's observable-model convention for shared state.
- Translate layout with stacks, grids, overlays, alignment, safe areas, and adaptive containers; avoid fixed browser dimensions, pervasive geometry measurement, and compensating offsets.
- Express shared materials through existing token, asset, environment, style, and modifier layers. Support Dynamic Type, localization, right-to-left, increased contrast, and accessibility labels, values, traits, and actions.
- Implement pointer hover only when the supported Apple platform and product behavior require it; never for iPhone.
- Drive interruptible animation from state and honor `@Environment(\.accessibilityReduceMotion)` with a reduced-motion equivalent.

### Android Jetpack Compose

- Prefer native or established controls. Reusable composables take `modifier: Modifier = Modifier` on their outer boundary and expose slots where callers need composition.
- Hoist state; keep reusable rendering composables stateless where practical, pass immutable state down, and emit events through callbacks. Use `rememberSaveable` only for local UI state that must survive recreation.
- Translate layout with `Row`, `Column`, `Box`, lazy or flow containers, constraints, arrangements, window insets, and adaptive window behavior; order modifiers deliberately.
- Use semantic theme values and resource-backed content; `dp` for layout, `sp` for text, no literal browser pixels or breakpoints.
- Preserve semantics, native toggle/selectable behavior, descriptions, sufficient targets, keyboard or D-pad focus, and non-color cues. Use `InteractionSource` only for platform-valid states; hover is not central to touch.
- Use standard Compose animation APIs, interruptible transitions, and the system motion-duration scale.

## Completion

Done when the slice uses the target design system appropriately, shared foundations are reused or extracted per the criteria above, behavior and accessibility are preserved, and focused checks pass. Report shared additions, intentional platform adaptations, unresolved conflicts or visual differences, and checks performed.
