# PiBox Feedback Hooks Specification

**Status:** Implemented  
**Initial scope:** Audio feedback for completed agent responses

## Purpose

Pi already provides typed extension lifecycle events. PiBox adds a small semantic feedback layer rather than duplicating Pi's event system or introducing unrestricted shell-command hooks.

## Initial contract

- `response-complete` is the only supported feedback event.
- It maps to Pi's `agent_settled` event.
- It fires after the whole ReAct loop, including automatic retries, compaction recovery, and queued continuations.
- The only action is asynchronous local sound playback.
- Playback occurs only in TUI mode.
- Missing local media fails silently.

`attention-required` and `task-completed` are intentionally deferred because Pi does not currently expose equivalent general lifecycle events.

## Sound themes

Committed JSON manifests map semantic feedback events to filenames. Manifests never contain audio data and filenames must resolve inside the selected user-local theme directory.

Default local media root:

```text
~/.pi/agent/pibox/sounds/<theme-id>/
```

The initial `eve-online` manifest references user-supplied copyrighted media. PiBox neither distributes nor downloads that media.

## Safety and performance

- Audio paths cannot be absolute or escape the selected theme directory.
- Playback uses argument-array process spawning rather than shell interpolation.
- The player is detached so agent settlement is never blocked by playback.
- No timers or background processes start during extension module loading.
- The first implementation supports macOS `afplay`; unsupported platforms are silent no-ops.

## Future evolution

Additional semantic events or feedback actions may be added without exposing every Pi lifecycle event as an arbitrary command execution surface. A general command-hook system requires a separate security and configuration design.
