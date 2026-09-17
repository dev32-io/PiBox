# cmux live subagent panes

When Pi starts inside cmux with both `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID`, PiBox opens live, non-focused panes for subagent assistant text and tool activity. Panes close when attempts settle. Outside cmux, integration is a silent no-op.

Set `PIBOX_CMUX_PANES=0` before starting Pi to disable it. Viewer panes are best-effort and never own or stop subagents.
