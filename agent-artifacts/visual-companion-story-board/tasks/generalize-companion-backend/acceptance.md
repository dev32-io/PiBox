# Task Acceptance: Generalize the Visual Companion backend contract

## Deliverables

- Make the existing loopback backend host multiple viewer types and common routes without changing Architecture behavior.

## Acceptance

- Existing Architecture backend and visualizer tests remain green without URL or document-contract regressions
- A registered non-artifact viewer can serve bounded routes before any artifact is shown
- Common and viewer routes remain path-contained and isolated
- Backend shutdown releases clients, watchers, timers, and the server

## Boundary Proof

- Focused backend tests demonstrate preserved Architecture behavior and the new non-artifact/common-route seams
