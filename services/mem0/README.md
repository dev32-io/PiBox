# Bundled local Mem0 service

This Compose stack is the local backend used by PiBox's memory adapter. It intentionally differs from Mem0's stock server image: a small FastAPI wrapper enables the Python SDK's FastEmbed provider while preserving the REST operations PiBox needs.

```bash
# The service adapter creates the data directories and API key first.
/services start mem0
/services status mem0
/services stop mem0
```

The API listens on `127.0.0.1:6001`. PostgreSQL is not exposed to the host. Durable data is bind-mounted beneath `~/.pi/pibox/services/mem0/`. Versions and the embedding model are pinned in the deployment files. Startup never pulls updates after an image has been built; `/services update mem0` is a separate approval-gated operation.

Only direct `infer=false` writes are accepted. The placeholder `OPENAI_API_KEY` exists solely because some Mem0 SDK versions initialize the default LLM client eagerly; PiBox never exposes an inferred-write route. Validate outbound traffic during each dependency upgrade.
