# cmux native subagent viewer

When Pi starts inside cmux with both `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID`, PiBox opens non-focused panes for live subagent attempts. Each pane uses Pi's native read-only transcript rendering, a pinned spawn title and cumulative attempt input/output counters. The pinned header is bold with a contrasting full-row background using terminal colors. Pane tabs receive the same stable title and close after attempts settle.

The first split gives one third to the agent area, keeping two thirds for the main session. Further agents split the largest owned agent pane into equal halves along its longest axis.

Rich assistant/tool detail is local, ephemeral, bounded, and enabled only after a bounded cmux availability probe. It is never added to subagent replay, reports, workflow state, or model-facing output. Existing attempts rebound by `/reload`, and older services without display subscription support, use limited compact output instead. Missing cmux, rename failures, viewer failure, or queue pressure never affect subagent execution; omitted live detail is marked in the viewer.

Panes default on. Set machine-wide default in `~/.pi/agent/settings.json`:

```json
{
  "cmuxPanes": { "enabled": false }
}
```

Use `/cmux-panes on`, `/cmux-panes off`, or `/cmux-panes status` for current session branch. `/cmux-panes` with no argument toggles current state. Session choice survives reload and tree navigation. Turning panes off closes only PiBox-owned viewer panes and subscriptions; agents keep running. Turning panes on reattaches active attempts and observes future attempts.

Outside cmux, command remains available and reports pane resources unavailable. Child runtimes never register command or create pane resources.
