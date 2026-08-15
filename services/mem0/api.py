import os
import secrets
import threading
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, Field
from fastembed import TextEmbedding as LocalTextEmbedding
from mem0 import Memory
import mem0.embeddings.fastembed as mem0_fastembed


# Mem0's FastEmbed adapter does not expose cache/local-only options. Pin it to
# the model baked into the image so runtime requests cannot trigger downloads.
mem0_fastembed.TextEmbedding = lambda model_name: LocalTextEmbedding(
    model_name=model_name,
    cache_dir="/models",
    local_files_only=True,
)

app = FastAPI(title="PiBox Mem0", docs_url=None, redoc_url=None)
_memory: Memory | None = None
_memory_lock = threading.Lock()
_operation_lock = threading.Lock()


def memory() -> Memory:
    global _memory
    if _memory is not None:
        return _memory
    with _memory_lock:
        if _memory is not None:
            return _memory
        database_url = os.environ["PIBOX_MEM0_DATABASE_URL"]
        _memory = Memory.from_config({
            "embedder": {
                "provider": "fastembed",
                "config": {"model": os.environ.get("PIBOX_MEM0_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")},
            },
            "vector_store": {
                "provider": "pgvector",
                "config": {
                    "connection_string": database_url,
                    "collection_name": "pibox_memories",
                    "embedding_model_dims": 384,
                },
            },
            "history_db_path": "/app/history/history.db",
        })
    return _memory


def configured_api_key() -> str:
    if value := os.environ.get("PIBOX_MEM0_API_KEY"):
        return value
    key_file = os.environ.get("PIBOX_MEM0_API_KEY_FILE", "/run/secrets/pibox_mem0_api_key")
    with open(key_file, encoding="utf-8") as handle:
        return handle.read().strip()


def authorize(x_api_key: str | None = Header(default=None)) -> None:
    expected = configured_api_key()
    if not expected or not x_api_key or not secrets.compare_digest(expected, x_api_key):
        raise HTTPException(status_code=401, detail="invalid API key")


def records(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("results", "memories"):
            if isinstance(value.get(key), list):
                return value[key]
    return []


def repo_matches(record: dict[str, Any], repo_id: str | None) -> bool:
    if not repo_id:
        return True
    metadata = record.get("metadata") or {}
    return metadata.get("repo_id") == repo_id or record.get("repo_id") == repo_id


def owned_memory(memory_id: str, user_id: str, repo_id: str) -> dict[str, Any]:
    record = memory().get(memory_id)
    if not isinstance(record, dict) or record.get("user_id") != user_id or not repo_matches(record, repo_id):
        raise HTTPException(status_code=404, detail="memory not found in repository scope")
    return record


class AddRequest(BaseModel):
    messages: list[dict[str, str]]
    user_id: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    infer: bool = False
    expiration_date: str | None = None


class SearchRequest(BaseModel):
    query: str
    user_id: str
    filters: dict[str, Any] = Field(default_factory=dict)
    limit: int = Field(default=5, ge=1, le=50)


class UpdateRequest(BaseModel):
    memory: str
    metadata: dict[str, Any] | None = None


@app.get("/health")
def health() -> dict[str, str]:
    with _operation_lock:
        memory()
    return {"status": "ok"}


@app.post("/memories", dependencies=[Depends(authorize)])
def add(request: AddRequest) -> Any:
    with _operation_lock:
        return memory().add(
            request.messages,
            user_id=request.user_id,
            metadata=request.metadata,
            infer=False,
            **({"expiration_date": request.expiration_date} if request.expiration_date else {}),
        )


@app.get("/memories", dependencies=[Depends(authorize)])
def list_memories(
    user_id: str = Query(...),
    repo_id: str | None = Query(default=None),
    show_expired: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=1000),
) -> list[dict[str, Any]]:
    filters = {"user_id": user_id, **({"repo_id": repo_id} if repo_id else {})}
    with _operation_lock:
        result = memory().get_all(filters=filters, top_k=limit, show_expired=show_expired)
        return [record for record in records(result) if repo_matches(record, repo_id)]


@app.post("/search", dependencies=[Depends(authorize)])
def search(request: SearchRequest) -> list[dict[str, Any]]:
    repo_id = request.filters.get("repo_id")
    with _operation_lock:
        result = memory().search(
            request.query,
            filters={"user_id": request.user_id, **request.filters},
            limit=request.limit,
        )
        return [record for record in records(result) if repo_matches(record, repo_id)][: request.limit]


@app.get("/memories/{memory_id}", dependencies=[Depends(authorize)])
def get(memory_id: str, user_id: str = Query(...), repo_id: str = Query(...)) -> Any:
    with _operation_lock:
        return owned_memory(memory_id, user_id, repo_id)


@app.put("/memories/{memory_id}", dependencies=[Depends(authorize)])
def update(memory_id: str, request: UpdateRequest, user_id: str = Query(...), repo_id: str = Query(...)) -> Any:
    with _operation_lock:
        current = owned_memory(memory_id, user_id, repo_id)
        metadata = {**(current.get("metadata") or {}), **(request.metadata or {}), "repo_id": repo_id}
        return memory().update(memory_id, request.memory, metadata=metadata)


@app.delete("/memories/{memory_id}", dependencies=[Depends(authorize)])
def delete(memory_id: str, user_id: str = Query(...), repo_id: str = Query(...)) -> dict[str, str]:
    with _operation_lock:
        owned_memory(memory_id, user_id, repo_id)
        memory().delete(memory_id)
        return {"status": "deleted"}


@app.get("/memories/{memory_id}/history", dependencies=[Depends(authorize)])
def history(memory_id: str, user_id: str = Query(...), repo_id: str = Query(...)) -> Any:
    with _operation_lock:
        owned_memory(memory_id, user_id, repo_id)
        return memory().history(memory_id)
