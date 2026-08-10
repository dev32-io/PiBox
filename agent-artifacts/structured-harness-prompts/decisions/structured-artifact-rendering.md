# Structured Artifact Rendering

## Decision

Canonical artifact capabilities accept typed semantic section values and render stable Markdown rather than treating complete free-form Markdown as their primary input.

Each artifact type has a typed section contract. Models provide substantive content, list items, stable acceptance identifiers, references, and optional additional sections. Capabilities validate those values, determine mechanically triggered conditional requirements, and render headings, ordering, list syntax, identifiers, and generated metadata deterministically.

Additional sections remain available through a bounded structured collection containing a heading and substantive Markdown body. They follow the artifact type's core sections and cannot replace or duplicate reserved headings.

Artifacts assembled from state already owned by the harness—evaluation reports, evidence summaries, findings, and outcomes—are rendered directly from structured manifests and handoffs wherever possible.

## Context

Validating model-authored Markdown after generation can detect malformed structure but still spends model turns on heading syntax, ordering, stable identifier formatting, and retries. Those are mechanical concerns. The harness already uses typed capabilities and deterministic rendering for YAML manifests, evidence checksums, findings, and lifecycle state.

## Rationale

Typed section inputs preserve model ownership of semantics while making document shape reliable by construction. They improve tool discoverability, reduce prompt instructions, produce consistent human-readable Markdown, and allow precise field-level errors before repository mutation. Bounded additional sections preserve proportionality and domain-specific context.

## Consequences

- `work_item_create`, artifact mutation, task definition, evaluation recording, and completion inputs require typed narrative contracts appropriate to the Markdown they produce.
- Renderers become the single source of heading names, order, list formatting, and generated identifiers.
- Existing raw-content inputs require a compatibility and migration strategy.
- Artifact readers continue consuming ordinary Markdown; canonical Git artifacts remain tool-independent and human-readable.
- Additional-section titles must not collide with reserved headings and their bodies must pass substantive-content validation.
- Prompt bodies become shorter because they describe semantic decisions rather than Markdown mechanics.

## Alternatives Considered

- Continue accepting complete Markdown and validate it afterward. Rejected as the primary interface because formatting retries waste model effort and duplicate renderer logic in prompts.
- Replace Markdown with YAML. Rejected because prose rationale and direct human reading remain important.
- Forbid additional sections. Rejected because artifact contracts must support domain-specific material without expanding every core schema.
