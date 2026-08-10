# Provider Integration Specification

## Scope

PiBox registers two independent native Pi providers:

- `ollama-cloud`
- `local-llm`

Both use Pi's provider and credential APIs, appear in `/login`, store secrets through Pi's credential store, discover models dynamically, and use Pi's OpenAI Chat Completions implementation.

## Ollama Cloud

- Display name: **Ollama Cloud**
- Authentication: API key
- Key prompt links to `https://ollama.com/settings/keys`
- Ambient key: `OLLAMA_API_KEY`
- API base: `https://ollama.com/v1`
- Discovery: `GET /models`
- Streaming: OpenAI-compatible `POST /chat/completions`

The OpenAI-compatible catalog does not expose complete Pi model metadata. PiBox supplements discovered IDs with a curated table derived from the official Ollama library pages for hosted context limits, reasoning support, and image input. Endpoint-provided metadata takes precedence. Unknown models use zero/unknown cost, a 128K context default, a 32K output default, and conservative capability inference from model names and advertised capability arrays.

## Local LLM

- Display name: **Local LLM**
- Authentication: endpoint URL followed by API key
- Ambient URL: `LOCAL_LLM_BASE_URL`
- Ambient key: `LOCAL_LLM_API_KEY`
- Protocol: OpenAI-compatible Chat Completions
- Discovery: `<base>/models`, then `<host>/v1/models` when the supplied URL is a bare host

Accepted URL conveniences:

- Missing protocol defaults to `http://`
- Trailing slash is removed
- A final `/models` is removed
- A final `/chat/completions` is removed

The successful discovery base URL is stored on each persisted model. This permits a bare host to resolve to `/v1` without incorrectly overriding it later through request authentication.

## Discovery contract

Supported model-list shapes:

```json
{ "data": [{ "id": "model-id" }] }
```

```json
{ "models": [{ "name": "model-id" }] }
```

A top-level model array is also accepted. Duplicate and empty IDs are discarded.

Discovery has a ten-second timeout, honors Pi's cancellation signal, and preserves Pi's previously persisted catalog when refresh fails.

## Compatibility defaults

Because generic model-list APIs rarely advertise request capabilities, PiBox defaults to:

- `openai-completions`
- no `store`
- system role instead of developer role
- `max_tokens`
- no strict or grammar tools
- streamed usage enabled
- text-only input unless a vision-capable name/capability is detected
- reasoning disabled unless a reasoning-capable name/capability is detected
- zero monetary cost

These defaults maximize compatibility but cannot guarantee that every model behind an OpenAI-compatible server supports tools, images, reasoning, or accurate token usage.

## Security

The local provider performs network requests to the URL entered by the user and sends the configured bearer token to that origin. It does not follow a provider supplied by model metadata. Users should only configure endpoints they trust.

A proprietary API that merely has a URL and key is not automatically compatible. It requires a dedicated protocol adapter unless it implements OpenAI-compatible `/models` and `/chat/completions` endpoints.
