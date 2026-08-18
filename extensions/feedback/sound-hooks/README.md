# Sound feedback hooks

Plays user-supplied sounds when Pi settles a response or a managed workflow reaches a useful attention boundary.

## Event

| Feedback event | Pi lifecycle event | Behavior |
|---|---|---|
| `response-complete` | `agent_settled` | Plays once after retries, compaction recovery, and queued follow-ups have finished |
| `workflow-task-completed` | PiBox task is merged/integrated into the canonical working branch | Plays once after the merge barrier, never at contribution handoff |
| `workflow-error` | PiBox workflow pauses for attention | Plays once when failure, blocking work, or a review checkpoint requires intervention |

PiBox intentionally does not use `agent_end`: that lower-level event can fire while Pi still has automatic work to do. Workflow sounds use the workflow runtime's shared feedback event so merge transitions and repeated status refreshes do not replay task-completion or attention audio.

## Audio installation

Audio is not distributed with PiBox. The default EVE Online manifest expects:

```text
~/.pi/agent/pibox/sounds/eve-online/eve-online-notification-ping.mp3
~/.pi/agent/pibox/sounds/eve-online/eve-online-skill-completed-chime-wo-aura.mp3
~/.pi/agent/pibox/sounds/eve-online/eve-online-capacitor-warning.mp3
```

If you already have the local Claude Code theme used by PiBox's author, copy it without adding it to this repository:

```bash
mkdir -p ~/.pi/agent/pibox/sounds/eve-online
cp ~/.claude/themes/eve-online/sounds/eve-online-notification-ping.mp3 \
   ~/.claude/themes/eve-online/sounds/eve-online-skill-completed-chime-wo-aura.mp3 \
   ~/.claude/themes/eve-online/sounds/eve-online-capacitor-warning.mp3 \
   ~/.pi/agent/pibox/sounds/eve-online/
```

The EVE Online name and audio belong to their respective owner. PiBox is unofficial, is not affiliated with or endorsed by CCP Games, and provides only a filename mapping for user-supplied media.

## Configuration

The extension works without configuration and currently supports macOS `afplay`.

| Environment variable | Default | Meaning |
|---|---|---|
| `PIBOX_SOUND_ENABLED` | `true` | Set to `0` or `false` to disable playback |
| `PIBOX_SOUND_THEME` | `eve-online` | Manifest name under `sound-themes/` |
| `PIBOX_SOUND_ROOT` | `~/.pi/agent/pibox/sounds` | Root containing one directory per sound theme |

Playback is limited to interactive TUI sessions. Missing manifests, audio files, or players are silent no-ops.
