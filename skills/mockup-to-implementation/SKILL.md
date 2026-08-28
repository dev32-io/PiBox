---
name: mockup-to-implementation
description: Translate or refine a requested production component or product slice from an approved repository HTML/CSS/JavaScript mockup into idiomatic React or Preact, SwiftUI, or Jetpack Compose code.
---

# Mockup to Implementation

Understand the approved mockup and the target design system before editing. Preserve appearance and behavior through platform-native architecture rather than reconstructing screenshots or mechanically copying web details.

## Authority

- The user's or orchestrator's requested component, state, or product slice is the scope boundary.
- The approved HTML, CSS, JavaScript, and linked assets are the authority for structure, behavior, responsive rules, layering, and motion.
- Provided handoff images are the visual authority for appearance; otherwise use the rendered approved mockup. Visual diffs are diagnostic evidence only.
- The target repository's instructions, design system, shared-component architecture, and platform conventions are the implementation authority.
- When refining an existing production component, preserve its working behavior and public API unless the request explicitly changes them.
- If these authorities conflict, inspect the relevant source and render. Stop and report a conflict that changes requested behavior, public contracts, or architecture; document smaller platform adaptations instead of choosing silently.

## Working Protocol

### 1. Understand both codebases before editing

Do not edit production code until you have explored the relevant source and target paths.

For the requested mockup slice, trace:

- its exact HTML boundary, semantics, content, variants, and states;
- every relevant CSS rule, variable, pseudo-element, responsive query, keyframe, asset, inherited style, layout constraint, and stacking relationship;
- the JavaScript owning events, state transitions, DOM updates, timing, interruption, and reduced-motion behavior.

In the target codebase:

- read the closest repository instructions and relevant platform/build configuration;
- locate and inspect the design-system entry points, themes, tokens, shared components, primitives, styles or modifiers, representative call sites, and focused test or preview patterns;
- trace actual implementations and consumers rather than assuming behavior from names.

Before the first edit, establish a brief working map of source behavior and visual recipes to existing target components, primitives, or tokens. Mark each concern as **reuse**, **extend**, **new local**, or **platform adaptation**, with a short reason. Keep this in working notes; do not create a repository artifact unless requested.

### 2. Build through the shared design system

Prefer, in order:

1. an existing shared component whose semantics and behavior fit;
2. composition from existing shared primitives and semantic tokens;
3. a small extension to the existing component or design-system layer;
4. a local implementation when the design is specific to the requested slice or reuse would change another component's semantics or behavior.

Search the target's component indexes, token definitions, sibling implementations, and repeated values before declaring anything new. Do not stop at local hardcoding merely because a shared abstraction does not already exist.

Extract the smallest useful shared token or primitive when there is concrete evidence that the concept belongs in the shared layer: it already repeats in the target, the mockup defines or reuses it as design language, or the requested component family shares it. Typical candidates include surfaces, fills, borders, shadows, glows, typography, spacing, shapes, interaction treatments, and motion recipes.

Before adding a token or primitive, confirm that an existing semantic equivalent does not already exist under another name. Place new shared work in the repository's established design-system layer, give it a semantic name, and update only the immediate consumers that should use it. Do not create a speculative API, universal component, framework, or shared token for an unexplained one-off adjustment.

### 3. Translate intent into platform-native code

- Preserve meaning, content hierarchy, state ownership, actions, accessibility, adaptive behavior, layering, and motion intent.
- Translate browser mechanisms into target-platform mechanisms; do not copy presentation-only DOM wrappers, CSS coordinates, browser breakpoints, or unsupported interaction states literally.
- Keep one source of truth for state and derive visual and accessibility state from it.
- Prefer native controls and established repository components, then style or compose them faithfully.
- Keep product-specific composition local while promoting proven reusable design language into the shared layer.
- Inspect how source effects are constructed; do not replace them with rough approximations merely because that is faster.

### 4. Verify and refine without pixel hunting

- Run the focused build, type, behavior, preview, and accessibility checks used by the target codebase. Exercise every requested state and relevant responsive or adaptive configuration.
- For each visual correction, re-read the responsible HTML, CSS, or JavaScript and identify the target-platform mapping causing the difference. Change that cause, not an unrelated offset that happens to reduce a score.
- Treat visual-diff measurements as diagnostic evidence, never as the sole completion target across different renderers.
- If you are about to add a magic constant, no-op modifier, impossible platform state, test-only production branch, or a second unexplained pixel nudge to the same element, stop. Re-derive the implementation from the source and shared primitives, or report the native difference; do not try another offset.
- Preserve correct native rendering, accessibility, and adaptive behavior when they require a deliberate platform difference, and report that adaptation.

## Platform Protocols

Apply only the subsection matching the target repository. If none matches, report the mismatch instead of guessing.

### React or Preact

- When the target reuses mockup CSS, preserve the minimum semantic DOM shape and class relationships its selectors require. Otherwise preserve the semantics and behavior while translating styles into the target CSS architecture; remove presentation-only wrappers the target does not need.
- Keep presentation, responsive layout, pseudo-states, and visual animation in CSS. Use component state to select semantic classes, attributes, and custom properties rather than writing per-frame visual values from JavaScript.
- Choose component boundaries around coherent behavior, semantics, or reusable visual responsibility. Keep state at the smallest appropriate owner and derive render values instead of mirroring them through effects.
- Prefer native HTML controls and preserve keyboard behavior, focus order, accessible names, and visible focus. Use complete ARIA behavior only when native HTML cannot express the control.
- Keep React or Preact as the single owner of rendered DOM. Use effects only to synchronize with external systems, and clean up listeners, observers, timers, and JavaScript-driven animation loops.
- Follow the project's React, Preact, or compatibility conventions exactly rather than assuming their event and runtime behavior is interchangeable.

### iOS SwiftUI

- Prefer native controls with custom `ButtonStyle`, `ToggleStyle`, and related repository conventions so activation, focus, disabled behavior, accessibility, and input adaptation remain correct.
- Keep local transient state at the smallest owner, pass bindings only when a child must mutate parent-owned state, and follow the repository's observable-model convention for shared state.
- Translate layout intent with stacks, grids, overlays, backgrounds, alignment, safe areas, and adaptive containers. Avoid fixed browser dimensions, pervasive geometry measurement, and compensating offsets.
- Express shared materials through the existing token, asset, environment, style, and modifier layers. Support Dynamic Type, localization, right-to-left layout, increased contrast, and meaningful accessibility labels, values, traits, and actions.
- Do not implement iPhone hover as a required state. Include pointer hover only when the supported Apple platform and product behavior require it.
- Drive interruptible animation from state and honor `@Environment(\.accessibilityReduceMotion)` with an understandable non-motion or reduced-motion equivalent.

### Android Jetpack Compose

- Prefer native or established controls. Reusable composables accept `modifier: Modifier = Modifier` on their outer boundary and expose slot content when callers need meaningful composition.
- Hoist state to the appropriate owner, keep reusable rendering composables stateless where practical, pass immutable state down, and emit events through callbacks. Use `rememberSaveable` only for local UI state that must survive recreation.
- Translate layout with `Row`, `Column`, `Box`, lazy or flow containers, constraints, arrangements, window insets, and adaptive window behavior. Apply modifier ordering deliberately because it changes measurement, input bounds, and drawing.
- Use semantic theme values and resource-backed content. Use `dp` for layout and `sp` for text; do not copy browser pixels or breakpoints literally.
- Preserve semantics, native toggle or selectable behavior, meaningful descriptions, sufficient targets, keyboard or D-pad focus where applicable, and cues that do not rely on color alone. Use `InteractionSource` only for platform-valid states; do not make hover central to touch behavior.
- Use standard Compose animation APIs, keep transitions interruptible, and respect the system motion-duration scale.

## Completion

Finish only when the requested slice uses the target design system appropriately, useful shared foundations have been reused or extracted where the criteria above are met, behavior and accessibility are preserved, and focused checks pass. Report shared additions, intentional platform adaptations, unresolved conflicts or visual differences, and the checks performed.
