# LLM + Embedding Providers

## Two Interface Families

- `LlmProvider` (`provider.ts`): `{ name, summarize(input) → LlmSummary }`
- `EmbeddingProvider` (`embedding-provider.ts`): `{ name, dimensions, embed(texts) → number[][], probe?() }` — the optional `probe()` fires a one-token embed request and throws `EMBEDDING_DIM_MISMATCH` when the declared width disagrees with the model's actual output. `runIndexPipeline` calls it before summarization so a misconfigured dimension fails fast, before any LLM spend.

These are separate interfaces with separate resolvers. A provider can implement one or both.

## Resolver Cascade

Both resolvers follow the same priority: CLI flag > env var > config.toml > auto-inference.

- LLM: `--provider` > `GDRIVESCOPE_LLM_PROVIDER` > `config.llm.provider` > infer from API keys
- Embedding: `--embedding-provider` > `GDRIVESCOPE_EMBEDDING_PROVIDER` > `config.embedding.provider` > infer from API keys

### Auto-Inference

When no provider is explicitly configured, resolvers scan available API keys:

- LLM priority: `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` → `ollamaConfig`
- Embedding priority: `OPENAI_API_KEY` → `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` → `VOYAGE_API_KEY` → `ollamaConfig`

### Model Cascade

Model selection per provider: provider-specific env var > `config.toml [llm].model` / `[embedding].model` > provider built-in default.

### Embedding Dimensions

Embedding vector width is also a resolver knob, because OpenAI, Voyage, and Azure OpenAI ship multiple embedding models with different native widths (e.g. `text-embedding-3-small` = 1536, `text-embedding-3-large` = 3072; `voyage-3-lite` = 512, `voyage-3` = 1024).

Precedence: provider-specific env var > `config.toml [embedding].dimensions` > provider built-in default.

Per-provider env vars:

- `GDRIVESCOPE_OPENAI_EMBEDDING_DIMENSIONS`
- `GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_DIMENSIONS`
- `GDRIVESCOPE_VOYAGE_EMBEDDING_DIMENSIONS`
- `GDRIVESCOPE_OLLAMA_EMBEDDING_DIMENSIONS`

When the explicit value differs from a provider's built-in default, that value is also sent on the wire as the API's `dimensions` / `output_dimension` parameter, so the request returns vectors at the declared width. The resolver does not validate the value — `probe()` runs at pipeline start and fails with `EMBEDDING_DIM_MISMATCH` if the model actually emits a different width.

## Providers

| Name | Type | Default Model | API Key |
|------|------|---------------|---------|
| `anthropic` | LLM | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| `openai` | LLM | `gpt-5.4-nano` | `OPENAI_API_KEY` |
| `azure-openai` | LLM | `gpt-5.4-nano` | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` |
| `ollama` | LLM | `llama3.2:3b-instruct` | none (local) |
| `openai` | Embedding | `text-embedding-3-small` | `OPENAI_API_KEY` |
| `azure-openai` | Embedding | `text-embedding-3-small` | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` |
| `voyage` | Embedding | `voyage-3-lite` | `VOYAGE_API_KEY` |
| `ollama` | Embedding | `nomic-embed-text` | none (local) |

## Adding a New Provider

1. Create `<name>.ts` implementing `LlmProvider` and/or `<name>-embedding.ts` implementing `EmbeddingProvider`
2. Constructor takes an options object with `model?: string` (default set in constructor)
3. Add the name to the `LlmProviderName` / `EmbeddingProviderName` union and `KNOWN` set in the relevant resolver
4. Add the construction branch in the resolver's `if` chain
5. Throw `CliError('...', 'PROVIDER_UNCONFIGURED')` when the required API key is missing
6. Add inference check in `inferLlmProvider()` / `inferEmbeddingProvider()`

## Structured Output

Summarization uses `LLM_SUMMARY_SCHEMA` (JSON Schema in `summary-schema.ts`) for structured output:

- Anthropic: `tool_use` with `tool_choice: { type: 'tool', name: 'record_summary' }`
- OpenAI / Azure OpenAI: `response_format.json_schema` with `strict: true`
- Output fields: `summary` (string), `classification` (enum), `key_topics` (string[])

## Classification

Defined as a const array in `classification.ts`. Values: pitch_deck, board_minutes, board_presentation, financial, reporting, newsletter, legal, strategy, hr, research, other. The schema and providers derive from this array — adding a classification only requires updating it.

## Prompts

- System prompt: `SUMMARY_SYSTEM` in `prompts.ts` — shared across all providers
- User prompt: `summaryUser()` — truncates markdown to first 3000 chars (`SUMMARY_USER_SNIPPET_CHARS`)
- Keep prompts provider-agnostic
