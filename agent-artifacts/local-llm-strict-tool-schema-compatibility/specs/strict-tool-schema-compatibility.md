# Strict local-server tool-schema compatibility

## Context

Some LM Studio local-server paths reject PiBox's outgoing tool definitions with HTTP 400 before model inference because function parameter schema roots are not represented as a literal object. The issue reproduces independently of thinking mode and copied chat templates.

## Required Behaviors

- The Local LLM provider shall preserve its existing login, discovery, model-selection, and streamed Chat Completions interface.
- For an identified strict-server compatibility path, PiBox shall serialize each outgoing function parameter root in a form accepted by servers requiring parameters.type to equal object.
- The transformation shall preserve the tool's externally usable object argument shape and shall not alter PiBox-side tool execution validation.
- The generic Local LLM path shall retain its current request representation unless strict-server compatibility is selected or detected.
- The implementation shall provide deterministic coverage for the rejected root-schema forms and ordinary unmodified behavior.

## Acceptance Criteria

- **AC-001:** A representative tool request whose parameter root would otherwise be rejected because its type is not a literal object is normalized so the strict-server request validator accepts it.
- **AC-002:** Normalized tools retain their names, descriptions, object properties, required fields, and argument behavior needed by PiBox tool execution.
- **AC-003:** The Local LLM provider's public endpoint/login/discovery interface is unchanged, and non-compatibility requests retain existing behavior.
- **AC-004:** Automated tests cover normalization, non-normalization, and preservation of valid ordinary object schemas.

## Actors

- PiBox user selecting a Local LLM endpoint
- Local OpenAI-compatible server with strict tool-schema validation

## Constraints

- Compatibility must be endpoint/server-oriented, not keyed to model names, chat templates, or Hugging Face model cards.
- Do not default to removing tools as a way to avoid the server error.

## Edge Cases

- A schema already rooted in type object must not be materially rewritten.
- Unsupported nested JSON Schema constructs must not be falsely claimed as fully compatible merely because the root is normalized.

## Out of Scope

- LM Studio server changes.
- General chat-template or reasoning-mode adaptation.
- A blanket guarantee for all OpenAI-compatible servers.
