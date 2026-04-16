---
name: gdrivescope
description: Google Drive indexing, search, and download via CLI. Activate when user mentions "Google Drive", "gdrive", or "gdrivescope" - examples: "Search my Drive", "Index my Google Drive", "Download Drive file", "List my Drive folders", "Show Drive file".
---

# Gdrivescope

## Rules

1. Only activate when Google Drive is mentioned
2. Always use `--json` and pipe through `jq` to keep context small
3. Check `.ok` in output — `true` = success, `false` = error
4. Run `gdrivescope login` once to authorize; `gdrivescope index` to build the local graph
5. Use `--metadata-only` for fast traversal without LLM/extraction cost
6. Set provider env vars for LLM features: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or configure Ollama
7. Use `--resume` on index to recover from partial failures without re-processing

## Output

Default: human-readable text. With `--json`: envelope format.

```json
{"ok":true,"data":[...]}
{"ok":false,"error":"...","code":"..."}
```

## Primary Workflow: Semantic search over a folder

```bash
# 0. Authorize (once)
gdrivescope login

# 1. Build (or refresh) the local index for a folder
gdrivescope --json index --scope FOLDER_ID

# 2. Semantic search within that scope
gdrivescope --json file search "quarterly revenue" --scope FOLDER_ID --limit 5 \
  | jq '.data[] | {id, name, path, score}'

# 3. Show a single hit in detail
gdrivescope --json file show FILE_ID | jq '.data | {name, path, summary, key_topics}'
```

## Common Patterns

```bash
# List a folder tree
gdrivescope --json file list FOLDER_ID -r | jq '.data[] | {id, name, mime_type}'

# Download a file to disk
gdrivescope --json file download FILE_ID -o ./report.pdf | jq '.data | {path, bytes}'

# Metadata-only index (fast, no LLM cost)
gdrivescope --json index --scope FOLDER_ID --metadata-only | jq '.data'

# Resume a failed or interrupted index
gdrivescope --json index --scope FOLDER_ID --resume | jq '.data'

# Prune files deleted from Drive
gdrivescope --json index --scope FOLDER_ID --prune | jq '.data'

# Name-based search (no embeddings needed)
gdrivescope --json file search "budget" --mode name --limit 10 | jq '.data[] | {name, path}'

# Show workspace config
gdrivescope --json config show | jq '.data'

# Add a root folder
gdrivescope --json config add-root FOLDER_ID --label "Team Drive" | jq '.data'

# List roots with node counts
gdrivescope --json config list-roots | jq '.data[] | {id, label, node_count}'

# Rebuild embeddings with a different provider
gdrivescope --json index --scope FOLDER_ID --embedding-provider voyage --rebuild-embeddings | jq '.data'
```

## Environment Variables

- **Auth:** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
- **LLM keys:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`
- **Defaults:** `GDRIVESCOPE_LLM_PROVIDER`, `GDRIVESCOPE_EMBEDDING_PROVIDER`
- **Ollama:** `GDRIVESCOPE_OLLAMA_HOST`, `GDRIVESCOPE_OLLAMA_MODEL`, `GDRIVESCOPE_OLLAMA_EMBEDDING_MODEL`, `GDRIVESCOPE_OLLAMA_EMBEDDING_DIMENSIONS`
- **Limits:** `GDRIVESCOPE_MAX_SIZE`, `GDRIVESCOPE_MAX_PDF_PAGES`

Error codes: `AUTH_ERROR` `NOT_FOUND` `MISSING_PARAM` `QUOTA_EXCEEDED` `PROVIDER_ERROR` `ERROR`

## References

- **All commands:** [ref-commands.md](ref-commands.md)
- **Full help:** `gdrivescope --help`
