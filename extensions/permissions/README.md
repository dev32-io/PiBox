# PiBox permissions

PiBox provides a lightweight Claude Code-style repository permission gate. It is an accident-prevention layer, not a sandbox: processes launched through `bash`, package scripts, interpreters, extensions, and MCP servers still run with the Pi process's operating-system authority.

## Repository policy

Place the policy at `.pi/permissions.yaml`:

```yaml
version: 1
default: ask

permissions:
  allow:
    - Read(./**)
    - Write(./**)
    - Edit(./**)
    - Bash(git status*)
    - Bash(npm test*)
    - Tool(task_*)
  ask:
    - Bash(git push*)
    - Bash(ssh *)
  deny:
    - Bash(rm -rf /)
    - Read(~/.ssh/id_*)
    - Write(~/.ssh/**)
```

Supported rule subjects are `Read`, `Write`, `Edit`, `Ls`, `Find`, `Grep`, `Bash`, `Mcp`, and `Tool`. `*` and `?` wildcards match tool targets. `${workspace}`, `${repository}`, `${home}`, `${tmp}`, and a leading `~` expand in patterns. Restrictive matches win: `deny` over `ask` over `allow`. A missing policy preserves Pi's normal permissive behavior; an invalid policy fails closed.

Simple shell chains joined by `&&`, `||`, `;`, or `|` are evaluated command by command. This parser and the policy itself are not containment boundaries. Opaque scripts can perform effects that are not visible in their command line.

The policy file is protected from direct `write`, `edit`, and statically visible Bash modification while permissions are enforced. Modify it as the user or enter bypass mode deliberately.

## Modes

- **ENFORCED** evaluates the repository tool permission policy. Interactive `ask` decisions open a confirmation; headless asks are denied.
- **BYPASS** permits every tool call without evaluating the repository tool permission policy.

Use `Shift+Tab` or `/permissions enforce|bypass`. The mode is session-scoped, survives reload/resume through session history, and is inherited by every spawned PiBox child. New interactive sessions begin enforced. The footer renders the current mode before reasoning effort.

Pi binds `Shift+Tab` to thinking-level cycling by default. PiBox overrides that shortcut for permissions. To remove the built-in conflict diagnostic and the old effort binding, set:

```json
{
  "app.thinking.cycle": []
}
```

in `~/.pi/agent/keybindings.json`. Reasoning effort remains available through `/effort`.

## Managed workflows

`workflow_start` always opens an extension-owned TUI confirmation explaining that unattended execution requires bypass. Cancellation leaves both the workflow and mode unchanged. After successful preparation and snapshot validation, PiBox switches the session to bypass before scheduling any work. All managed and direct children launched afterward inherit bypass. Harness authority, Git isolation, review, verification, and recovery controls remain active.
