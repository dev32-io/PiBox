# Intent: Visual Story Board

## Problem

PiBox stories, tasks, documents, evaluation reports, and evidence are distributed across canonical YAML and Markdown artifacts and are substantially harder to understand than they should be. The Visual Companion currently serves only architecture artifacts, starts only through that viewer, and has no reusable application shell or consistent design system.

## Desired Outcome

A developer can start a fast, loopback-only Visual Companion and use a polished Story Board to browse repository stories, inspect a traditional three-column task board, read grouped documents, and navigate reports and canonical evidence without blocking startup or exposing live workflow internals.

## Scope — Included

- Idempotent /services start, status, and stop behavior for visual-companion
- A shared Visual Companion shell with Story Board and Architecture tabs
- A read-only story catalog and nested story workspace sourced from canonical agent-artifacts
- A three-column To do, In progress, and Done task board that preserves exact task statuses
- Grouped Documents and independently browsable Reports views with bidirectional task/report links
- Safe Markdown rendering for documents, reports, and canonical evidence, including inline canonical local images
- Asynchronous lazy story discovery and parsing, session-scoped caching, and manual Refresh
- Degraded but visible handling for malformed or historical artifacts
- A shared professional neutral design-token system used by Story Board and Architecture
- Responsive, keyboard-accessible browser interactions and deterministic fixture-driven browser verification
- A standalone production-path assisted E2E launcher that lets a managed browser evaluator exercise the extension without a nested Pi/TUI session

## Success Signals

- Starting Visual Companion opens an interactive shell quickly without eagerly parsing stories
- Developers can navigate from a story catalog to a three-column task board, grouped documents, and a report catalog
- Reports and task details cross-link while reports remain independently browsable
- Canonical Markdown and local evidence images render safely and readably
- Malformed artifacts degrade locally without hiding healthy stories or rewriting source files
- Story Board loading, Refresh, Architecture regression, responsive behavior, and accessibility are verifiable through the production-path assisted E2E launcher and browser automation

## Scope — Excluded

- Live workflow status, TUI snapshot projection, or continuous story watching
- Reading private or volatile .pibox events, sessions, transcripts, stdout, stderr, handoffs, or recovery records
- Editing stories or tasks, drag-and-drop status changes, or browser workflow controls
- Remote or non-loopback serving
- Automatic migration or rewriting of historical artifacts

## Constraints

- Service startup must expose the shell before any Story Board repository scan begins
- Story Board filesystem work must be asynchronous and begin only after the browser activates Story Board
- Switching viewers must remain responsive while Story Board content loads
- Canonical artifact reads must remain read-only and path-contained
- Architecture visualization behavior and direct opening must remain compatible
- Browser E2E must exercise production backend, routes, readers, projector, assets, and UI through a deterministic loopback launcher rather than a test-only substitute or nested Pi/TUI session
