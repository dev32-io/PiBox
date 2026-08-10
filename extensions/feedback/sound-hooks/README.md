# Sound feedback hooks

Plays a user-supplied sound after Pi finishes the complete agent loop and is ready for input.

## Event

| Feedback event | Pi lifecycle event | Behavior |
|---|---|---|
| `response-complete` | `agent_settled` | Plays once after retries, compaction recovery, and queued follow-ups have finished |

PiBox intentionally does not use `agent_end`: that lower-level event can fire while Pi still has automatic work to do. Permission and task-completion sounds are deferred until Pi exposes corresponding standard lifecycle events.

## Audio installation

Audio is not distributed with PiBox. The default EVE Online manifest expects:

```text
~/.pi/agent/pibox/sounds/eve-online/eve-online-notification-ping.mp3
```

If you already have the local Claude Code theme used by PiBox's author, copy it without adding it to this repository:

```bash
mkdir -p ~/.pi/agent/pibox/sounds/eve-online
cp ~/.claude/themes/eve-online/sounds/eve-online-notification-ping.mp3 \
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
