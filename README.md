<h1 align="center">
  <img src="docs/assets/pibox-logo.svg" alt="PiBox" width="420">
</h1>

<p align="center">
  <a href="https://github.com/dev32-io/PiBox/actions/workflows/ci.yml?query=branch%3Adevelop"><img src="https://img.shields.io/github/actions/workflow/status/dev32-io/PiBox/ci.yml?branch=develop&amp;style=flat-square&amp;label=CI" alt="CI status on develop"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-d99a7b?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/badlogic/pi-mono"><img src="https://img.shields.io/badge/Pi-%E2%89%A5%200.84.3-62656f?style=flat-square" alt="Pi 0.84.3 or newer"></a>
</p>

PiBox is a mode-driven extension pack for the [Pi coding agent](https://github.com/badlogic/pi-mono). It adds a focused terminal, activation-scoped subagents, private session scratch, repository-aware visual design, and an optional managed workflow that carries reviewed ideas through implementation and verification.

## Choose how PiBox works

New sessions start in **Agent** mode. From an empty editor, press `Down` to enter the interactive footer, or use `/mode <name>` directly.

| Mode | Use it for |
|---|---|
| **Agent** | Direct repository work with ordinary tools, optional scratch, and bounded subagents. |
| **Orchestrator** | Plan-and-ledger coordination with deliberate delegation and final verification. |
| **Workflow** | Reviewed stories and plans followed by managed stages, checks, repair, review, and E2E. |
| **Designer** | Repository-aware visual exploration, mockups, and implementation handoff. |

Modes are session-branch-local and select authority, not permission: Workflow still requires separate story and plan review plus an explicit start or resume. See [work modes](docs/work-modes.md) for cache behavior, restoration, and scratch semantics.

## What PiBox adds

| Area | Highlights |
|---|---|
| **Terminal UX** | `rattle` theme, refined input, responsive status, keyboard-driven interactive footer, reusable dialogs, spinners, and compact styled transcript and tool output. |
| **Subagents** | Activation-scoped foreground/background `subagent_spawn`, status, stop, and continuation controls, live progress, bounded delivery, and event-aware `wait` without shell polling. |
| **Models and speed** | Capacity-aware fallback across managed-agent routes, tier profiles, ChatGPT Fast mode for the main agent and selected child tiers, Codex usage meters, and local LLM or Ollama Cloud support. |
| **Managed workflow** | Reviewed stories and plans, sequential or concurrent stages, isolated Git worktrees, checks, integration, bounded repair, whole-branch review, and final E2E. |
| **Context and control** | Enforced repository permissions, path-scoped rules, private session scratch, curated memory, and evidence-backed distillation without silent writes. |
| **Visual and local tools** | Designer authority, live architecture diagrams, browser mockups, a reactive workflow board, lazy local services, and optional sound feedback. |

## Quick start

Requires [Pi 0.84.3 or newer](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md#quick-start).

```bash
npm install
npm run verify
pi -e .
```

`pi -e .` loads PiBox for one run. To keep it installed:

```bash
pi install /absolute/path/to/PiBox
```

Pi packages run with your user permissions; review the source and configuration before installation.

## From idea to working product

![Accelerated Pi TUI recording of a todo app moving from an initial request through story shaping, staged implementation, review, E2E verification, and the delivered Aero Todo product](docs/assets/workflow-demo/workflow-demo.gif)

*An accelerated reenactment grounded in a completed PiBox run. [View the static poster.](docs/assets/workflow-demo/workflow-demo-poster.png)*

The main agent shapes an open request into a product contract and a separate delivery plan. You review both before execution. After an explicit start, PiBox owns stage scheduling, isolated Git worktrees, deterministic checks, integration, bounded repair, whole-branch review, and final E2E. Material decisions return to you instead of silently changing the contract.

```text
/mode workflow
/workflow init [standard|economy]
/workflow status

Discuss → review the story → review the plan → say “start the workflow”
```

Managed execution lives only within the current Pi activation; quitting is treated as a crash, not detached background operation. See the [workflow guide](docs/workflow.md) for setup, authoring, recovery, and evidence.

![Visual Companion showing the completed Aero Todo workflow with progress, delivery metrics, sequential and concurrent stages, and final assurance](docs/assets/workflow-demo/workflow-dashboard.png)

## Everyday controls

| Control | Purpose |
|---|---|
| `Down` from an empty editor | Enter the interactive footer; arrows navigate, `Enter` confirms, and `Esc` closes. |
| `/mode <agent\|orchestrator\|workflow\|designer>` | Change work mode directly. |
| `/scratch` | Inspect, reset, or purge private session scratch. |
| `Shift+Tab` or `/permissions` | Switch between enforced and bypass permission modes. |
| `/tier-profile` | Change managed-agent model routing. |
| `/fast` | Configure ChatGPT Fast mode for the main agent and subagent tiers. |
| `/services` | Inspect or control local PiBox services. |
| `/memory-status`, `/memory-audit` | Inspect repository-scoped memory or audit stored items without changing them. |
| `/distill` | Turn an explicit code, release, time, path, workflow, or session range into user-reviewed knowledge proposals. |
| `/skill:architecture-visualizer` | Open a live architecture explanation in the Visual Companion. |

## Documentation

- **Modes and workflow:** [work modes](docs/work-modes.md) · [workflow](docs/workflow.md) · [collaboration flow](docs/agent-collaboration-flow.md) · [E2E](docs/workflow-e2e.md)
- **Agents and models:** [agent workflow](docs/specs/agent-workflow.md) · [model tiers](docs/model-tier-guidance.md) · [Fast mode](extensions/fast-mode/README.md) · [provider integrations](docs/specs/provider-integrations.md)
- **Interface:** [interactive footer](extensions/tui/interactive-footer/README.md) · [status and usage](extensions/tui/status-bar/README.md) · [styled output](extensions/tui/styled-outputs/README.md) · [visual TUI](docs/specs/visual-tui.md)
- **Safety and context:** [permissions](extensions/permissions/README.md) · [path-scoped rules](extensions/rule/README.md) · [memory](extensions/memory-adapter/README.md) · [distillation](extensions/distill/README.md)
- **Local integrations:** [services](extensions/service-adapter/README.md) · [sound](extensions/feedback/sound-hooks/README.md) · [local models](extensions/providers/local-llm/README.md) · [Ollama Cloud](extensions/providers/ollama-cloud/README.md)

Local services start lazily and never update without explicit approval. MCP transport and copyrighted audio remain user-supplied.

## Development

```bash
npm run check
npm test
npm run eval:workflow
```

CI runs these checks for pushes and pull requests to `develop`, the serving branch. Generated benchmark data stays under ignored `.benchmark/` paths.

## License

[MIT](LICENSE)
