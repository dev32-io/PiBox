# Local LLM provider

Registers **Local LLM** in Pi's `/login` selector. Login asks for:

1. An OpenAI-compatible API base URL
2. Its API key

The URL may include `/v1`, `/models`, or `/chat/completions`; PiBox normalizes those forms. When only a host is supplied, discovery tries both `/models` and `/v1/models`.

Models are dynamically discovered from the standard models endpoint and persisted by Pi. Requests use streamed OpenAI Chat Completions. This works with compatible services such as Ollama, LM Studio, vLLM, llama.cpp servers, LiteLLM, and many hosted gateways.

Environment alternative:

```bash
export LOCAL_LLM_BASE_URL=http://localhost:1234/v1
export LOCAL_LLM_API_KEY=your-key
```

"Any URL" means any **OpenAI-compatible** endpoint. A service with a proprietary request protocol or no model-list endpoint needs a dedicated adapter or manual model configuration.
