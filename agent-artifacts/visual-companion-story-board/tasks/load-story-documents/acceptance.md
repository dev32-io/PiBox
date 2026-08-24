# Task Acceptance: Load contained story document bodies on demand

## Deliverables

- Return one selected canonical story document as bounded Markdown without exposing arbitrary files or affecting sibling content.

## Acceptance

- Only cataloged canonical story documents can be read
- Document bodies are not read until the detail loader is called
- Escapes and non-regular files fail closed without absolute-path leakage
- A failed document leaves sibling documents available

## Boundary Proof

- Focused document-loader tests exercise every category and containment failure using disposable files
