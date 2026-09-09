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

`title` is optional display text: preferably 3–7 words, at most 80 characters. It is normalized to one plain-text line. It does not enter the child prompt, select a role, grant permissions, or replace the opaque `agentId`. Spawn, continuation, background delivery and footer rows retain the title alongside the original agent type. Untitled historical entries still render.

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

Background report previews are bounded to 1,200 bytes. To retrieve the already-produced report, use `subagent_read`, not another continuation:

```json
{ "agentId": "<handle>", "limit": 8000 }
```

The result includes `attemptId`, zero-based Unicode-character `offset`, `count`, `totalCharacters`, and `nextOffset` when another page exists. Subsequent reads should supply the returned `attemptId` and `nextOffset`; a newer continuation report rejects the old attempt ID rather than mixing pages. Pages contain at most 12,000 Unicode characters / 48KB of report text, plus a small identity/pagination header.

Reading does not launch a model, consume a continuation capability, or wait for active work. It works for completed, failed and cancelled terminal reports, and reads only the latest settled report for that standalone agent. Reports and titles survive same-activation `/reload`; released agents and replacement activations cannot be read. No transcript paths, credentials, workflow state, or event replay are exposed by the tool.
