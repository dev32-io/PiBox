# Task Brief: Build the production-path assisted E2E launcher

## Contribution Goal

Make the real Visual Companion extension surface deterministically launchable by the managed browser evaluator without a nested Pi/TUI session or test-only product substitute.

## Boundary — Included

- Reusable assisted-launch API and standalone CLI bound to a random loopback port
- Machine-readable startup line, bounded diagnostics, fixture-only delayed-discovery and malformed-artifact recovery controls, and exactly-once explicit/signal shutdown
- Disposable canonical fixture repository covering every approved E2E case and status/report/evidence/document state
- Production-module composition assertions and focused launcher/fixture-integrity/lifecycle tests
- Evaluator-facing usage contract for launching, parsing the URL, driving Playwright, collecting evidence, and cleanup

## Required Work

- 1. Add a reusable launch function accepting repositoryRoot, optional architecture artifact, optional fixture-only discovery delay, loopback host, and random port, returning host, port, URL, diagnostics URL or equivalent bounded diagnostic interface, and an idempotent close function.
- 2. Add a standalone CLI/script that prints one machine-readable JSON startup record, remains alive until SIGINT/SIGTERM or explicit control shutdown, reports only sanitized bounded diagnostics needed for approved hidden invariants, and closes production resources exactly once.
- 3. Compose the exact production Visual Companion host, registry, common shell, Story Board readers/projectors/cache/routes/Markdown/browser assets, and Architecture viewer; add an identity/composition assertion so tests fail if a test-only data path or renderer replaces production modules.
- 4. Materialize disposable canonical fixtures containing active/completed/archived/legacy/degraded stories; every three-column and exact task status; all document groups; task/story/stage/final/E2E reports; multiple attempts, findings, accepted risk; text/local-image/missing/unsupported/external evidence; and a valid Architecture artifact.
- 5. Add fixture-only bounded controls for observably delayed discovery and replacing one malformed disposable resource with a valid counterpart so E2E can prove non-blocking activation and Refresh recovery without introducing product-only delay/debug behavior.
- 6. Ensure all mutable fixture copies live under disposable temporary roots, all browser URLs bind only to loopback, diagnostics omit unrestricted filesystem paths, and cleanup removes listeners, SSE clients, watchers, timers, temporary mutable state, and signal handlers.
- 7. Add focused tests for random binding, startup JSON, production module composition, fixture coverage mapped to E2E-001 through E2E-006, intentional malformed/valid fixture integrity, bounded diagnostics, delayed discovery, recovery mutation containment, explicit close, SIGINT/SIGTERM, no nested Pi dependency, and no leaked process resources.
- 8. Document the exact evaluator command/handshake/cleanup sequence in the launcher usage output or adjacent developer documentation without adding a repository-pinned Playwright runner.

## Integration Expectation

Run from the fully integrated production browser surface; remain independent of accessibility/visual polish files so both final-stage tasks can execute concurrently.

## Context

- The E2E evaluator can use Bash and Playwright MCP but cannot invoke the session-owned visual_companion tool.
- The launcher must compose the integrated production host, viewer registry, shell, Story Board reader/projector/cache/routes/Markdown/browser assets, and Architecture adapter.
- Approved E2E-001 through E2E-006 require healthy, complete, historical, malformed, reports/evidence/images, delayed discovery, refresh recovery, Architecture, keyboard, and narrow-viewport states.

## Boundary — Excluded

- Managed evaluation resources or evaluator verdict logic
- A repository-pinned Playwright dependency, alternate browser renderer, nested Pi/TUI automation, or non-loopback serving
- Changes to product behavior solely for test timing or fixture mutation

## Interfaces and Dependencies

- Consumes the fully integrated production Visual Companion factories and assets plus disposable canonical fixture builders.
- Produces a machine-readable loopback URL, bounded diagnostics/recovery controls, and deterministic shutdown protocol consumed by the low-tier final E2E evaluator for all six matrix cases.

## Constraints

- The launcher must exercise production modules and fail closed if composition silently diverges.
- Fixture delay and mutation controls exist only under explicit disposable launcher configuration and cannot target the real repository.
- Startup and diagnostics output must be machine-readable, bounded, sanitized, and stable enough for a fresh evaluator.
- No nested Pi/TUI process, external network binding, retained credentials, or leaked listener/watcher/timer/temp state.
