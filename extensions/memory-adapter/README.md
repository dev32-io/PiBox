# PiBox memory adapter

The memory adapter uses a shared, loopback-only Mem0 OSS service for repository-scoped recall and explicit curated writes. Repository identity is derived from the canonical Git common directory, so linked worktrees share memory while unrelated repositories remain separated.

## Commands

```text
/memory-status
/memory-start
/memory-stop
/memory-audit
```

The `memory_adapter` tool supports `status`, `remember`, `recall`, `list`, `get`, `update`, `delete`, `history`, and advisory `audit` actions. Writes always use `infer=false`; PiBox does not capture turns or tool results automatically. When Mem0 is already healthy, PiBox injects active `project-policy` records on every turn plus up to five semantically relevant active records, with a combined 6,000-character cap. Passive recall probes Mem0 directly rather than trusting a potentially stale service-registry snapshot, but never auto-starts the service.

Every curated record carries `repo_id`, type, source, evidence paths, verified commit/date, status, and schema version. Current source and reviewed repository contracts outrank recalled memory.

`/memory-audit` runs deterministic freshness/evidence checks, caps candidates at 50, and asks the main session for a semantic recommendation. When candidates exist, the audit prompt requires read-only explorer subagents to verify claims against current source before the main session reconciles recommendations. It never mutates memory. Recommendations are `keep`, `reverify`, `update`, `supersede`, `archive`, `delete`, or `needs_user`; mutation requires explicit user approval.

## Local service

On first start, PiBox generates a mode-`0600` API key at `~/.pi/pibox/services/mem0/api-key`; both the extension and loopback-only container read that file. `PIBOX_MEM0_API_KEY` remains available as an explicit override.

The bundled deployment uses Mem0 with FastEmbed (`BAAI/bge-small-en-v1.5`) and PostgreSQL/pgvector. It omits the dashboard and extraction LLM, disables telemetry, binds only `127.0.0.1:6001`, persists vectors and history beneath `~/.pi/pibox/services/mem0/`, and bakes the embedding model into the pinned API image so runtime embedding does not require network access.
