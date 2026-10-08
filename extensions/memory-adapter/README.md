# PiBox memory adapter

The memory adapter uses shared, loopback-only Mem0 OSS for repository-scoped recall and curated knowledge. Repository identity comes from the canonical Git common directory: linked worktrees share memory; unrelated repositories do not.

## Agent behavior

The main agent may proactively save useful, non-sensitive repository preferences, user corrections, accepted decisions, and verified reusable lessons. Search related memories before saving to avoid duplicates. Do not store secrets, raw transcripts, unaccepted proposals, routine task progress, or facts already covered by repository documentation.

Recall is appropriate when prior decisions or preferences matter, after a meaningful task change, or when a recurring failure suggests relevant past work. Skip unnecessary searches for trivial self-contained tasks. These decisions are model-guided, not a guarantee that every useful lesson will be saved. PiBox does not force extra model turns or run a background extraction agent.

Subagents can read memory but cannot curate it; the main agent owns saves. Updates, deletions, and audit-driven mutations still require explicit user approval. Normal tool permission rules remain authoritative—memory is not a permission bypass.

Writes use `infer=false`: Mem0 stores the curated content supplied by the agent, rather than extracting facts from complete conversations. Current source and reviewed repository contracts outrank recalled memory. Repository-wide procedural rules belong in `AGENTS.md` or scoped rules, not hidden memory.

## Recall and context

At the start of a normal agent run, PiBox performs a bounded lookup using current and recent user intent. It selects relevant active records, verifies their provenance/freshness, and returns at most 4,000 characters as a custom evidence message before the first model response. Passive retrieval probes an already-running Mem0 service; it does not start the service.

The delivered snapshot is persisted in the session at its original position. Later tool loops, steering, and new user turns do not move or remove it. A later explicit recall returns an ordinary tool result. Neither path sends a steering instruction or starts an extra model turn. Steering does not itself repeat bootstrap retrieval: the agent can make a targeted recall if the objective changes.

Recall content explicitly identifies itself as historical evidence, not new user instructions. Custom messages become user-role content for the provider; their metadata alone is not an instruction boundary. Persisted snippets are included in session files and exports. Branching and reload use Pi's ordinary session history. Compaction is an intentional context-reset boundary: snapshots can be summarized rather than retained verbatim, and the agent should retrieve current evidence again when needed.

For user-derived knowledge, supply `conversationQuote`: an exact excerpt from a user message in the active session branch. PiBox verifies the match and records the session ID, entry ID, and quote hash rather than storing the quotation as provenance. No unrelated tracked file is needed as fake evidence. For code-derived knowledge, supply repository-relative `evidencePaths`: regular tracked files must match the current commit when saved and the verified commit when recalled. Choose one provenance kind, not both. Updating a user-derived memory requires fresh conversation proof.

Automatic and explicit `recall` share eligibility checks. Expired, stale, unsupported, or unrelated records are excluded; `list` and `get` remain available for inspecting repository records. A snapshot identical to the latest memory message still present in context is reused rather than appended again; `/memory-debug` reports `reused`.

## Visibility and commands

Successful saves and recalls produce concise activity notices without dumping stored text. Empty, unavailable, and rejected recall outcomes are inspectable through `/memory-debug`. Activity is not repeated for every tool-loop request. The Mem0 service indicator describes service health, not whether anything was remembered or recalled.

```text
/memory-status
/memory-start
/memory-stop
/memory-debug
/memory-audit
```

The `memory_adapter` tool supports `status`, `remember`, `recall`, `list`, `get`, `update`, `delete`, `history`, and advisory `audit`. Explicit tool operations can start the local service lazily. `/memory-debug` inspects existing diagnostics without triggering a model turn or retrieval.

`/memory-audit` performs bounded deterministic checks, then asks the main session for a semantic recommendation. When candidates exist, read-only explorer subagents verify claims against source before the main session reconciles them. Audit recommendations never mutate memory automatically.

## Local service

On first start, PiBox generates a mode-`0600` API key at `~/.pi/pibox/services/mem0/api-key`; both the extension and loopback-only container read that file. `PIBOX_MEM0_API_KEY` remains available as an explicit override.

The bundled deployment uses Mem0 with FastEmbed (`BAAI/bge-small-en-v1.5`) and PostgreSQL/pgvector. It omits the dashboard and extraction LLM, disables telemetry, binds only `127.0.0.1:6001`, persists vectors and history beneath `~/.pi/pibox/services/mem0/`, and bakes the embedding model into the pinned API image so runtime embedding does not require network access.
