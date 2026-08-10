# Ollama Cloud provider

Registers **Ollama Cloud** in Pi's `/login` selector with an API-key flow.

1. Create a key at <https://ollama.com/settings/keys>.
2. Run `/login` and select **Ollama Cloud**.
3. Choose its API-key method and paste the key.
4. Select a discovered `ollama-cloud/...` model through `/model`.

Models are discovered from Ollama's OpenAI-compatible `https://ollama.com/v1/models` endpoint and persisted by Pi's model registry. Requests use streamed OpenAI Chat Completions at `https://ollama.com/v1`.

`OLLAMA_API_KEY` is also supported as an ambient credential. The OpenAI-compatible model list currently omits most capability fields, so PiBox ships metadata derived from each model's official Ollama library page, including hosted context limits, reasoning support, and image input. Endpoint-provided metadata takes precedence, known catalog entries use the curated table, and unknown future models retain conservative 128K context/32K output defaults plus model-name inference.
