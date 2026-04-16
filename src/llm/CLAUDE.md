# LLM + Embedding Providers

## Two Interface Families

- `LlmProvider` (`provider.ts`): `{ name, summarize(input) → LlmSummary }`
- `EmbeddingProvider` (`embedding-provider.ts`): `{ name, dimensions, embed(texts) → number[][] }`

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
