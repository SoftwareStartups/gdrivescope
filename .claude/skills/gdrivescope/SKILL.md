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

## Output

```json
{"ok":true,"data":[...]}
{"ok":false,"error":"...","code":"..."}
```

## Primary Workflow: Semantic search over a folder

```bash
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

# Download raw bytes to disk
gdrivescope --json file download FILE_ID -o ./out.bin | jq '.ok'

# Metadata-only index (fast, no LLM cost)
gdrivescope --json index --scope FOLDER_ID --metadata-only | jq '.ok'

# Check auth
gdrivescope --json login | jq '.ok'
```

Error codes: `AUTH_ERROR` `NOT_FOUND` `MISSING_PARAM` `QUOTA_EXCEEDED` `PROVIDER_ERROR` `ERROR`

## References

- **Full help:** `gdrivescope --help`
