# Task Acceptance: Render grouped Documents with one safe Markdown pipeline

## Deliverables

- Provide readable lazy document accordions and a reusable sanitized Markdown renderer for both Documents and Reports.

## Acceptance

- Document bodies load only when opened and render as readable sanitized Markdown
- Absent categories are omitted and one failed document does not break siblings
- External images never issue automatic requests
- Only validated companion evidence image URLs can render inline
- Markdown libraries are direct locked dependencies rather than transitive imports

## Boundary Proof

- DOM/security tests inspect network-free external images, sanitized output, lazy fetch counts, and representative Markdown fixtures
