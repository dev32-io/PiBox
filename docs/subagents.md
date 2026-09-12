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

`title` is optional display text: preferably 3–7 words, without a hard character ceiling. It is normalized to one plain-text line. It does not enter the child prompt, select a role, grant permissions, or replace the opaque `agentId`. Spawn, continuation, background delivery and footer rows retain the title alongside the original agent type. Untitled historical entries still render.

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

`subagent_read` remains a compatibility reader of the same saved report, not a second report store:

```json
{ "agentId": "<handle>", "limit": 8000 }
```

Its result includes `attemptId`, zero-based Unicode-character `offset`, `count`, `totalCharacters`, and `nextOffset` when another page exists. Supply `attemptId` on later pages to reject a newer continuation result rather than mixing reports. Pages contain at most 12,000 Unicode characters / 48KB of report text, plus a small header. Services without file metadata retain their in-memory compatibility path.

Reports have `0600` permissions in private `0700` directories. Release and teardown do not delete them; `/tmp` retention is OS-managed and best effort, with no PiBox cleanup job or durability promise. Ordinary file reads remain possible while the file exists, independently of a live agent handle. `subagent_read` is still activation/handle-scoped. Missing files and report capture failures are reported explicitly. Failure or cancellation status is separate from any captured response: an existing file does not mean the attempt succeeded.

## Transport and completion

Agent descriptions and assignment text are not rejected because of arbitrary character counts. Full prompt content uses file-backed input rather than a potentially oversized process argument; display previews remain independent of the content delivered to the child.

A child-only extension sends bounded progress and lifecycle records over a dedicated event channel. Native Pi JSON output is drained without accumulating cumulative `agent_end` or tool payloads. Large reports travel through the report file, not one size-limited JSON record. This boundary is shared by standalone and workflow children; deterministic workflow consumers still receive complete final text rather than a preview.

`agent_end` alone is not completion: Pi may retry, compact, or process follow-ups. A successful result requires the final report, `agent_settled`, successful process exit, and drained output. Malformed compact protocol, missing settlement, and failed report capture remain failures rather than being silently accepted.
