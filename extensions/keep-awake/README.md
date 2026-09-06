# Keep awake

On macOS, this standalone extension quietly prevents idle system and display sleep while the main agent or any PiBox subagent is active. It is **enabled by default**, with no status-bar indicator or routine notifications. Other platforms are a no-op.

## Session command

- `/keep-awake on` — enable for this session; also retry a failed assertion process.
- `/keep-awake off` — release this session's assertion even if agents are still working.
- `/keep-awake status` (or `/keep-awake`) — show the setting and runtime status, including unsupported platforms.

The override is a private session entry, restored across reload/resume and from the selected session-tree branch. New sessions use the global default; forks inherit choices present in their branch. Commands never write global or project configuration.

## Configuration — enabled by default

**No configuration is needed.** Keep awake is enabled automatically on macOS and holds assertions only while agents are working. The extension does not create or modify your settings file.

If you want to state the default explicitly in `~/.pi/agent/settings.json` (or the configured Pi agent directory), use:

```json
{
  "keepAwake": { "enabled": true }
}
```

To **opt out for new sessions**, set `keepAwake.enabled` to `false`. To disable it only in the current session, use `/keep-awake off` instead.

Only global settings are read. Missing/invalid fields default to enabled. A valid session choice takes precedence.

## Lifecycle and limits

The main-session extension subscribes to `agent_start` / `agent_settled` and the existing owner-fenced `SubagentService`. Launching, running, and stopping children all count, including foreground, background, and workflow-managed children. Retries and queued follow-ups do not release the main-agent hold prematurely. A running tool or blocking prompt inside an active agent run retains the hold; an idle session or paused workflow with no active agents does not.

On demand, it starts `/usr/bin/caffeinate -d -i -w <Pi PID>` without a shell or detached process. One assertion process is held until all agents settle or the setting is disabled. Shutdown/reload releases it; PID binding also limits its lifetime if Pi crashes. The new activation restores its preference and current child activity after reload. Multiple Pi sessions hold independent assertions; disabling one does not release another's hold.

Failures do not interrupt agent work. A failure is reported once per activation; automatic respawn loops are avoided, and `/keep-awake on` explicitly retries. Child runtimes do not launch their own keep-awake processes.

This does not change macOS preferences, unlock the Mac, simulate user input, or override deliberate locking, lid closure, or managed screen-lock policies. Keeping the display awake consumes additional power.
