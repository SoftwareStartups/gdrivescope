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
gdrivescope --json search "quarterly revenue" --scope FOLDER_ID --limit 5 \
  | jq '.data.hits[] | {id, name, path, score}'

# 3. Show a single hit in detail
gdrivescope --json show FILE_ID \
  | jq '.data | {name: .node.name, path, summary: .node.summary, key_topics: .node.key_topics}'
```

## Common Patterns

```bash
# List a folder tree
gdrivescope --json list FOLDER_ID -r | jq '.data.files[] | {id, name, mime_type}'

# List only folders (or only files / shortcuts / other)
gdrivescope --json list FOLDER_ID -r --type folder | jq '.data.files[] | {id, name}'

# Download a single file to disk
gdrivescope --json download FILE_ID -o ./report.pdf | jq '.data | {output_path, bytes}'

# Recursively mirror a folder + write `<filename>.md` sidecars for every extractable file
gdrivescope --json download FOLDER_ID -o ./tmp/ --convert | jq '.data | {scope_name, bytes_total, converted, files: (.files | length)}'

# Metadata-only index (fast, no LLM cost)
gdrivescope --json index --scope FOLDER_ID --metadata-only | jq '.data'

# Resume a failed or interrupted index
gdrivescope --json index --scope FOLDER_ID --resume | jq '.data'

# Prune files deleted from Drive
gdrivescope --json index --scope FOLDER_ID --prune | jq '.data'

# Name-based search (no embeddings needed)
gdrivescope --json search "budget" --mode name --limit 10 | jq '.data.hits[] | {name, path}'

# Show workspace config
gdrivescope --json config show | jq '.data'

# Add a root folder
gdrivescope --json config add-root FOLDER_ID --label "Team Drive" | jq '.data'

# List roots with node counts
gdrivescope --json config list-roots | jq '.data[] | {id, label, node_count}'

# Rebuild embeddings with a different provider
gdrivescope --json index --scope FOLDER_ID --embedding-provider voyage --rebuild-embeddings | jq '.data'

# Configure local Ollama (pulls models, writes config.toml)
gdrivescope --json ollama setup | jq '.data'
```

## Roots

A **root** is a Drive folder (identified by Folder ID) registered as a stable anchor point. When you `index --scope <subfolder>`, gdrivescope walks up to find the matching root and stamps `root_id` on every indexed node so paths remain consistent across runs. Roots are persisted in the platform-specific workspace config (`~/Library/Application Support/gdrivescope/config.toml` on macOS, `~/.config/gdrivescope/config.toml` on Linux, `%APPDATA%\gdrivescope\config.toml` on Windows — resolved via the `dirs` crate's `config_dir()`) and managed via `gdrivescope config add-root|remove-root|list-roots` — typically one root per logical drive area you want to index.

## Environment Variables

- **Auth:** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
- **LLM keys:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`
- **Defaults:** `GDRIVESCOPE_LLM_PROVIDER`, `GDRIVESCOPE_EMBEDDING_PROVIDER`
- **Ollama:** `GDRIVESCOPE_OLLAMA_HOST`, `GDRIVESCOPE_OLLAMA_MODEL`, `GDRIVESCOPE_OLLAMA_EMBEDDING_MODEL`, `GDRIVESCOPE_OLLAMA_EMBEDDING_DIMENSIONS`
- **Limits:** `GDRIVESCOPE_MAX_SIZE`, `GDRIVESCOPE_MAX_PDF_PAGES`

Error codes: `AUTH_REQUIRED` `AUTH_FAILED` `SCOPE_REQUIRED` `NODE_NOT_FOUND` `MISSING_ARG` `BAD_ARG` `USAGE` `PROVIDER_UNCONFIGURED` `PROVIDER_UNKNOWN` `PROVIDER_UNAVAILABLE` `EMBEDDING_DIM_MISMATCH` `NO_EMBEDDINGS` `VEC_EXTENSION_FAILED` `LLM_CALL_FAILED` `LLM_MALFORMED_OUTPUT` `LLM_BATCH_SUBMIT_FAILED` `LLM_BATCH_POLL_FAILED` `LLM_BATCH_TIMEOUT` `EMBED_CALL_FAILED` `EXTRACT_FAILED` `PDF_SLICE_FAILED` `UNSUPPORTED_MIME` `OUTPUT_PATH_INVALID` `IO_FAILED` `DOWNLOAD_TREE_FAILED` `OLLAMA_PULL_FAILED` `UNKNOWN_COMMAND` `UNKNOWN`

## References

- **All commands:** [ref-commands.md](ref-commands.md)
- **Full help:** `gdrivescope --help`
