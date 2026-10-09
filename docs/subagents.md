# Standalone subagents

`subagent_spawn` delegates one self-contained assignment. Foreground calls wait and stream progress; background calls return a handle and deliver a bounded terminal report automatically. Background work is activation-scoped, not detached.

## Agent definitions and titles

The spawn tool exposes each loaded agent's name, description, and default tier. Built-in definitions live in `agent-definitions/*.md`; trusted repository definitions in `.pi/agents/*.md` can add or override agents. Selection guidance belongs in each Markdown file's frontmatter, not a separate hardcoded role table. YAML harness policy cannot override Markdown descriptions or tool allowlists. The catalog refreshes on session start and `/reload` without injecting agent prompt bodies into the main session.

```json
{
  "agent": "implementer",
  "title": "Fix RTL bubble corners",
  "task": "A complete bounded assignment with evidence, constraints and verification...",
  "tier": "high",
  "mode": "background"
}
```

`title` is required for each new `subagent_spawn`: use a descriptive display label, preferably 3–7 words, without a hard word-count or character ceiling. Missing or blank titles are rejected after normalization to one plain-text line. It does not enter the child prompt, select a role, grant permissions, or replace the opaque `agentId`. Continuation, background delivery and footer rows retain the original title alongside the agent type; continuation does not request another title. Untitled historical entries still render using the agent type and opaque `agentId`.

## Models, effort and fallback

| Request | Meaning |
|---|---|
| No routing fields | Use the definition's model when configured, otherwise its default tier in the active profile. |
| `tier` | Choose the ordered configured model/effort list. |
| `tier` + `effort` | Override only the primary route's effort. An unavailable primary may fall back; fallback routes keep their own configured efforts. |
| `model` | Select an exact registered ID or `provider/model`, optionally suffixed with `#effort`. Strict by default. Shorthand such as `luna` is not fuzzy-matched. |
| `model` + `allowFallback: true` | Permit pre-launch substitution from the selected/default tier. |
| `model#effort` + separate `effort` | Both values must agree; conflicts fail before launch. |

### Smallest-sufficient tier guidance

A caller may override an agent's default tier either up or down; the defaults and guidance are not hard caps. Choose the smallest tier sufficient for the bounded assignment:

- **Low:** bounded scans, extraction, focused research, and routine checks.
- **Medium:** ordinary implementation, review, and investigation.
- **High:** difficult, tightly coupled work. This is the normal ceiling.
- **Max:** a very rare exception for a specific reasoning bottleneck when High is insufficient—or when there is a concrete task-specific reason to expect High will be insufficient—and better context, tools, or safe decomposition will not solve it. Explain why High is insufficient and what benefit Max is expected to provide. If unsure between High and Max, choose High.

Task size, importance or security labels, urgency, vague uncertainty, and a single failed attempt are not sufficient reasons for Max. A Nuke profile upgrades the models backing routes; it does not upgrade task tiers. Tier choice adds no mandatory field, automatic escalation, retry, workflow-task default change, or runtime cap.

A custom `agent.model` remains authoritative when `tier` is supplied; `tier` does not silently replace a pinned model. Only an explicit spawn `model` replaces it. A pinned `local-llm/...` model has an effective default tier of `local`; non-local tier overrides are rejected while that model is selected. The existing exact-model, strict-by-default fallback behavior and provider isolation for `local` remain unchanged.

Unsupported explicitly requested effort fails rather than being silently clamped or hidden by substitution. For an explicit model without effort, a configured model uses its route effort (selected tier first, then other non-local tiers); a registered model absent from configuration uses `off`. Supply effort when it matters.

Explicit model selection can cross non-local capability tiers; in that case `tier` identifies the fallback list, not a model-strength guarantee. Explicit model requests consult the available registry rather than the session's scoped-model snapshot and may refresh the named provider once. Definition defaults and tier requests honor session model scoping.

`local` is provider-isolated. Explicit `local-llm/...` models imply `local`; a conflicting explicit tier fails. Explicit local model requests stay strict even with `allowFallback: true`, and local routing never falls back to paid providers.

Routing details retain requested and resolved model/effort plus selection attempts. Allowed substitutions are announced as **requested → actual** with a reason in model-visible output and the TUI.

Standalone fallback is **pre-launch availability resolution only**. Runtime provider failures settle the standalone child as failed. Managed workflow launchers separately own classified runtime fallback; this tool does not add retries or replace workflow controls.

## Continue work versus read a report

`subagent_continue` sends a **new assignment** to a settled logical agent, waits for it, and retains the original agent type, title, resolved model/effort, tool configuration and transcript. Changing the tier profile does not reroute an existing agent. Spawn a new logical agent to change its routing or role.

The shared subagent extension deterministically saves the latest assistant response as plain text in a private, attempt-specific `/tmp/pibox-subagent-attempt-*/report.md`. It does not ask the model to write a report, and the file contains neither the full conversation nor reasoning/tool-event payloads. Each continuation gets a new report path, so earlier report references stay stable.

Foreground results inline small reports; large results return a bounded preview and the full report path. Background previews remain bounded to 1,200 bytes and include the path. Prefer ordinary `read` and `grep` on that path to retrieve or search the existing response without another subagent turn:

```json
{ "path": "/tmp/pibox-subagent-attempt-EXAMPLE/report.md", "offset": 1, "limit": 200 }
```

`subagent_read` remains a compatibility reader, not a second report store. For ordinary agents it reads the same saved native report; for `e2e-tester` it reads the current attempt's validated workspace `report.json`:

```json
{ "agentId": "<handle>", "limit": 8000 }
```

Its result includes `attemptId`, zero-based Unicode-character `offset`, `count`, `totalCharacters`, and `nextOffset` when another page exists. Supply `attemptId` on later pages to reject a newer continuation result rather than mixing reports. Pages contain at most 12,000 Unicode characters / 48KB of report text, plus a small header. Services without file metadata retain their in-memory compatibility path.

Reports have `0600` permissions in private `0700` directories. Release and teardown do not delete them; `/tmp` retention is OS-managed and best effort, with no PiBox cleanup job or durability promise. Ordinary file reads remain possible while the file exists, independently of a live agent handle. `subagent_read` is still activation/handle-scoped. Missing files and report capture failures are reported explicitly. Failure or cancellation status is separate from any captured response: an existing file does not mean the attempt succeeded.

## E2E workspace

`e2e-tester` additionally uses the generic `e2e_workspace` capability for standalone and managed evaluations. It restores a private `/tmp` workspace through its own session binding, keeps successive report/evidence snapshots separate, and hands off a tool-written `report.json` with references to selected retained evidence. Compatible `subagent_continue` reopens the same workspace; a new/forked session does not adopt it. Random workspace paths are attempt/tool data, not changes to stable SYSTEM context or repository cwd.

Only keep useful sanitized witnesses: individual relevant screenshots or focused text/JSON/log excerpts, with a reason for retention. Do not bulk-copy directories, builds, dependencies, databases, caches or full logs. Routine pass details can stay inline. Retained snapshots are not removed when the worker or worktree is torn down, but `/tmp` retention remains best effort. Missing workspace data is explicitly unavailable, not silently replaced or discovered elsewhere.

The native `report.md` described above remains the process transport's final assistant text. Standalone automatic delivery never treats that prose as E2E verdict. It validates the E2E-specific handoff and returns only a deterministic receipt: canonical outcome, case counts, finding severity counts, exact `report.json` path, retained evidence count/location, and a normal `read`/`grep` instruction. Full report content stays in authoritative workspace file and is returned only by an explicit read. Missing or invalid handoffs are reported as unavailable or error without inventing an outcome. Child process completion/failure status remains separate from report outcome.

Workspace capability owns its files; workflow is only a reader and never copies new E2E artifacts into Git. Process-lifetime background delivery retains only bounded receipt/reference metadata so `/reload`, automatic steering, and `wait` deliver same result without duplicating report. Every automatic E2E envelope identifies attempt. If continuation has advanced same logical agent before older background delivery arrives, older receipt still delivers exactly once labeled as historical completion with current attempt ID; both immutable report paths remain valid. See [Workflow E2E](workflow-e2e.md) for case and evidence contract.

## Native MCP

This native MCP integration was audited against Pi 0.99.2; there is no runtime version gate, so re-audit its original-tool identity capture and discovery-readiness bridge on Pi upgrades. MCP is one binary capability in agent-definition frontmatter:

```yaml
tools: [read, grep, bash, mcp]
```

`mcp` grants every configured native MCP server's tools and resources, including resource listing, templates, and reads. Omit it to disable MCP for that agent. `*` includes MCP. Ordinary tool grants remain independent: adding `mcp` does not grant unrelated PiBox or extension tools. The legacy `mcp:<server>` syntax is rejected; replacing it with `mcp` intentionally broadens access to all configured servers, including future additions.

Excluded MCP tools must be absent from direct declarations, codemode descriptions and discovery (`ALL_TOOLS`, `searchTools`, `describeTool`, `describeNamespace`), deferred tool search, and resource access. MCP-off prompts also omit native server summaries and instructions, including subsequent prompt updates. Guessing a tool name cannot make it callable. These boundaries remain in permission-bypass mode. Exposure chooses how granted tools are presented, not whether an agent is granted them. `codemode` is the initial native default; it remains useful for non-MCP tools independently of the `mcp` capability.

Configure personal servers in `~/.pi/agent/mcp.json`, or shared project servers in a trusted `.pi/mcp.json`, using native Pi's `mcpServers` format. Keep credentials out of Git. Project entries replace same-name global entries. Native Pi owns transport, authentication, discovery, and connection cleanup; PiBox does not add another MCP transport or credential store. PiBox's `extensions/subagent/native-mcp.ts` entry composes the native extension to preserve original tool identities for repository permission rules. Activate this entry explicitly through Pi's extension settings (using its installed absolute path) or `-e` only after removing the legacy adapter; it must not share an activation with another `/mcp` owner. Keep `-builtin:mcp` in extension settings alongside the PiBox entry to suppress duplicate automatic loading and its replacement warning. This disables only the separately loaded builtin entry: PiBox still runs native MCP through `createMcpExtension()`. It is not enabled by the package manifest during the adapter-compatible transition. When active in the parent, PiBox also loads it explicitly in children.

Restricted children receive a snapshot of native tool names available in the parent's runtime registry when launched. PiBox explicitly awaits native discovery before standalone/workflow snapshots and initial exposure restoration; Pi 0.99.2 no longer waits for indirect servers on its first prompt. This bridge invokes the audited native discovery handler captured through public extension registration, not a documented stable readiness API. Cancellation and session changes prevent stale snapshots. A structural readiness failure withdraws native tools/resources and blocks their dispatch even in bypass; ordinary tools remain usable. After correcting the configuration, reload extensions to restore MCP. Lifecycle errors alone are not an enforcement boundary because Pi may continue the prompt. Later-arriving tools remain excluded until a fresh launch takes a newer snapshot; an existing continuation does not silently gain tools. Wildcard agents retain dynamic discovery within their explicit wildcard grant. Missing optional servers do not broaden access to another capability.

Before switching from `pi-mcp-adapter`, preserve its configuration and exact package version for rollback, copy the standard server fields into native `mcp.json`, and remove adapter-only settings. In particular, `lifecycle`, `exposeResources`, and adapter script settings are not native equivalents. MCP-on agents receive native resources as well as tools; MCP-off agents receive neither. Native startup may connect enabled servers even when their tools are excluded from an agent, so tool exclusion is not a promise of lazy process startup.

Validate with `pi mcp list`, which connects to configured servers, then test an adapter-free session and representative children. Only remove the adapter after capability tests pass and all active work is idle. Do not rely on command ownership alone to disable native MCP: adapter 3.3.0 registers its alias late on Pi 0.99.1, which can leave both integrations running if native configuration is present. While retaining or restoring that adapter, disable native MCP explicitly with `"extensions": ["-builtin:mcp"]` (merge with unrelated entries) and do not load PiBox's native composition. For native cutover, remove the adapter and activate PiBox's native entry while retaining the builtin exclusion before starting a fresh session. After removal, `/reload` or start a fresh idle session, inspect native `/mcp`, and repeat allowed/denied capability checks. Pi 0.99.1's `/mcp` status notification is not surfaced in JSON-print mode; use `pi mcp list` for shell diagnostics or native TUI/RPC status instead. Do not automatically resume a managed workflow as part of configuration migration.

## Transport and completion

Every child explicitly loads PiBox's permissions extension, including standalone, workflow, and E2E agents launched without globally installed PiBox. The canonical extension path is deduplicated with normal package discovery. Children inherit the parent's enforced/bypass permission mode; binary MCP and ordinary tool-capability restrictions remain enforced in either mode. This adds no recursive orchestration controls.

Agent descriptions and assignment text are not rejected because of arbitrary character counts. Full prompt content uses file-backed input rather than a potentially oversized process argument; display previews remain independent of the content delivered to the child.

A child-only extension sends bounded progress and lifecycle records over a dedicated event channel. Native Pi JSON output is drained without accumulating cumulative `agent_end` or tool payloads. Large reports travel through the report file, not one size-limited JSON record. This boundary is shared by standalone and workflow children; deterministic workflow consumers still receive complete final text rather than a preview.

`agent_end` alone is not completion: Pi may retry, compact, or process follow-ups. A successful result requires the final report, `agent_settled`, successful process exit, and drained output. Malformed compact protocol, missing settlement, and failed report capture remain failures rather than being silently accepted.
