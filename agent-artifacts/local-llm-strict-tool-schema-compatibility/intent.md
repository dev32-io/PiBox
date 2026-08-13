# Intent: Make Local LLM compatible with strict tool-schema servers

## Problem

PiBox's generic Local LLM provider sends standard OpenAI tool definitions that some LM Studio paths reject before inference when function parameter schemas are not rooted in a literal object. This prevents otherwise usable community and fine-tuned local models from starting a PiBox session.

## Desired Outcome

Local models served through strict OpenAI-compatible endpoints can receive PiBox tool definitions and begin tool-enabled sessions without changing the existing Local LLM login, discovery, or model-selection experience.

## Scope — Included

- Add a narrowly scoped outgoing tool-schema compatibility path for strict local OpenAI-compatible servers, initially covering LM Studio.
- Preserve tool names, descriptions, and executable argument contracts while converting unsupported root parameter-schema forms into the server-accepted object form.
- Add deterministic regression coverage using representative rejected schema shapes and ensure ordinary OpenAI-compatible local requests retain current behavior.
- Document the compatibility behavior and its boundary.

## Success Signals

- A local LM Studio request that previously fails with function.parameters.type expecting object is accepted and reaches inference.
- PiBox tool invocation still validates and executes correctly after schema normalization.
- Existing Local LLM discovery and generic endpoint behavior remain unchanged outside the compatibility path.

## Scope — Excluded

- Changing model chat templates, thinking-mode behavior, or model-card metadata.
- Disabling tools as the default workaround.
- Changing LM Studio itself or claiming support for every non-OpenAI local-server extension.

## Constraints

- Keep the existing local-llm provider interface and generic OpenAI Chat Completions behavior.
- Apply compatibility based on server/endpoint capability rather than model names or model-card formats.
- Do not silently weaken PiBox's tool execution validation.

## Assumptions

- The observed HTTP 400 occurs before model inference in LM Studio's request validator.
- The actual outgoing request can be captured to identify the rejected schema forms before implementation.
