# Active agent slot accounting

## Decision

A main Pi session may own at most sixteen nonterminal logical subagent assignments. A slot is reserved atomically before the first child process attempt and remains attached to that logical agent across process exits, checkpoints, waits, pauses, protocol nudges, recovery, and later process attempts. Only a terminal lifecycle transition releases the slot.

Slot-consuming states are:

- reserved
- launching
- running
- waiting_model
- waiting_capacity
- waiting_decision
- blocked
- paused
- interrupted
- recovery_required
- reported

Slot-releasing terminal states are:

- completed
- failed
- protocol_failed
- cancelled

Resuming an existing logical agent creates another process attempt under its already-held slot; it never performs a second reservation. A new assignment fails before process creation when sixteen slots are held.

## Context

The limit protects system resources, provider cost, coordination capacity, and future resumptions—not only the number of OS processes currently consuming CPU. Releasing a slot while an assignment waits would allow sixteen replacements to launch and later permit the waiting assignment to resume as a seventeenth child.

## Rationale

Binding the slot to the logical assignment provides stable accounting across background execution and main-session restarts. It also makes the future dashboard count correspond to unresolved subagents owned by the session rather than transient process states. Conservative retention prevents queued, paused, capacity-limited, or decision-blocked work from bypassing the cap.

Process attempts remain separately bounded by role-specific protocol, repair, and retry policy. The sixteen-slot limit does not authorize unlimited sequential attempts within one assignment.

## Consequences

- Waiting and paused agents remain visible and consume capacity until resumed to terminal completion or explicitly cancelled.
- Reported agents retain capacity until the main session validates and reconciles their handoffs.
- Recovery must preserve slot ownership idempotently across reload and resume.
- Cancellation and terminal failure preserve historical records while releasing the slot.
- Operators may need explicit controls to cancel or resolve stale assignments before launching more work.
