# Ollama Cloud provider

Registers **Ollama Cloud** in Pi's `/login` selector with an API-key flow.

1. Create a key at <https://ollama.com/settings/keys>.
2. Run `/login` and select **Ollama Cloud**.
3. Choose its API-key method and paste the key.
4. Select a discovered `ollama-cloud/...` model through `/model`.

Models are discovered from Ollama's OpenAI-compatible `https://ollama.com/v1/models` endpoint and persisted by Pi's model registry. Requests use streamed OpenAI Chat Completions at `https://ollama.com/v1`.

`OLLAMA_API_KEY` is also supported as an ambient credential. Ollama's model catalog does not publish complete context, output, image, or reasoning metadata, so PiBox applies conservative defaults and model-name capability inference.
