# Background agent liveness and capacity recovery

## Decision

A child process writes a heartbeat every five seconds containing its stable logical agent ID, random process-attempt ID, PID, and timestamp. A fresh matching heartbeat is sufficient evidence that the registered attempt is alive. PID existence without a fresh matching heartbeat is ambiguous and transitions the logical agent to `recovery_required`; the harness neither kills that PID nor starts a duplicate writer automatically.

A provider-capacity or model-availability wait ends the current process attempt but leaves the logical agent in `waiting_capacity` or `waiting_model`. The agent retains its active slot and resumes only through an explicit orchestrator or user action. V1 does not automatically schedule a delayed retry.

## Context

PiBox must support children continuing after the main process exits without depending on parent-owned streams. Cross-platform process-start fingerprinting is inconsistent, and a PID alone may have been reused. Automatic delayed capacity retry was already deferred and would complicate cost, cancellation, and session ownership.

## Rationale

A short file-backed heartbeat provides useful liveness and future dashboard updates without platform-specific process inspection. Conservative ambiguity handling prevents accidental termination of unrelated processes and duplicate access to one workspace. Explicit capacity resume keeps provider cost and timing visible to the user while preserving the logical assignment and its reserved slot.

## Consequences

- Child output, transcript, heartbeat, checkpoint, messages, and handoff remain authoritative files.
- The main session can observe a surviving child by tailing files after resume, but cannot claim to reattach its former stdout pipe.
- Stale-heartbeat recovery may require explicit cancellation or confirmation before another attempt can launch.
- Waiting agents remain visible and count against the sixteen-agent limit until completed, failed, or cancelled.
- Automatic delayed capacity scheduling remains out of scope for this change.
