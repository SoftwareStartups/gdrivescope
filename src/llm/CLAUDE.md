# LLM + Embedding Providers

## Two Interface Families

- `LlmProvider` (`provider.ts`): `{ name, summarize(input) → LlmSummary }`
- `EmbeddingProvider` (`embedding-provider.ts`): `{ name, dimensions, embed(texts) → number[][] }`

These are separate interfaces with separate resolvers. A provider can implement one or both.

## Resolver Cascade

Both resolvers follow the same priority: CLI flag > env var > config.toml > hardcoded default.

- LLM: `--provider` > `GDRIVESCOPE_LLM_PROVIDER` > `config.llm.provider` > `"anthropic"`
- Embedding: `--embedding-provider` > `GDRIVESCOPE_EMBEDDING_PROVIDER` > `config.embedding.provider` > `"openai"`

## Adding a New Provider

1. Create `<name>.ts` implementing `LlmProvider` and/or `<name>-embedding.ts` implementing `EmbeddingProvider`
2. Add the name to the `LlmProviderName` / `EmbeddingProviderName` union and `KNOWN` set in the relevant resolver
3. Add the construction branch in the resolver's `if` chain
4. Throw `CliError('...', 'PROVIDER_UNCONFIGURED')` when the required API key is missing

## Structured Output

Summarization uses `LLM_SUMMARY_SCHEMA` (JSON Schema in `summary-schema.ts`) for structured output:

- Anthropic: `tool_use` with `tool_choice: { type: 'tool', name: 'record_summary' }`
- OpenAI: `response_format.json_schema` with `strict: true`
- Output fields: `summary` (string), `classification` (enum), `key_topics` (string[])

## Classification

Defined as a const array in `classification.ts`. Values: pitch_deck, board_minutes, board_presentation, financial, reporting, newsletter, legal, strategy, hr, research, other. The schema and providers derive from this array — adding a classification only requires updating it.

## Prompts

- System prompt: `SUMMARY_SYSTEM` in `prompts.ts` — shared across all providers
- User prompt: `summaryUser()` — truncates markdown to first 3000 chars (`SUMMARY_USER_SNIPPET_CHARS`)
- Keep prompts provider-agnostic
