# Task Acceptance: Build the reusable Visual Companion platform

## Deliverables

- Provide one loopback-only Visual Companion host with reusable viewer registration, shell-first startup, idempotent service lifecycle, and preserved direct Architecture behavior.

## Acceptance

- Starting Visual Companion through /services makes an interactive shell route available without invoking Story Board discovery.
- Starting an already-running companion reuses the backend and URL; status reports the running state; stop releases listeners, SSE clients, watchers, timers, and viewer resources.
- Opening Architecture directly selects the Architecture viewer under the common route without initiating Story Board parsing.
- Existing Architecture backend validation and live-refresh tests continue to pass.
- Common, viewer, and dynamic routes reject unknown or escaping paths.

## Boundary Proof

- Focused backend and service tests observe no discovery call before Story Board activation, one reused backend across repeated starts, direct Architecture compatibility, route isolation, and no process-pinning resources after close.
