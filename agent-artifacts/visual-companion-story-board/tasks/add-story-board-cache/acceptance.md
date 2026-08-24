# Task Acceptance: Add session-scoped Story Board lazy cache

## Deliverables

- Share in-flight and completed Story Board reads while making manual Refresh safe, isolated, and retryable.

## Acceptance

- Duplicate concurrent reads execute one loader call
- Failed reads can be retried
- Refresh starts a new asynchronous generation and stale results cannot overwrite it
- Architecture state is unaffected
- No parsing occurs until a cache-backed loader is explicitly invoked

## Boundary Proof

- Deterministic cache tests control promise settlement order and inspect loader call counts and generations
