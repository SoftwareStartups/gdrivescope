# Commands

All examples use `--json` for jq piping. Output uses envelope: `{ok, data}` / `{ok, error, code}`.

## Auth

```
gdrivescope login [flags]
gdrivescope logout
```

| Flag | Args | Purpose |
|------|------|---------|
| `--client-id` | `<id>` | Google OAuth client id |
| `--client-secret` | `<secret>` | Google OAuth client secret |
| `--scope` | `<name>` | OAuth scope (see below) |

OAuth scopes: `drive.metadata.readonly` (default), `drive.readonly`

Credential resolution order: flags → env vars (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`) → OS keychain → interactive prompt.

```bash
# Login with default scope
gdrivescope login

# Login with full read access
gdrivescope login --scope drive.readonly

# Logout
gdrivescope logout
```

## Index

```
gdrivescope index [flags]
```

| Flag | Args | Purpose |
|------|------|---------|
| `--scope` | `<FOLDER_ID>` | Start folder id or alias (default: `root`) |
| `--metadata-only` | | Skip extraction + LLM + embeddings |
| `--resume` | | Only process nodes without summary or with errors |
| `--prune` | | Delete store rows for files no longer in Drive |
| `--provider` | `<name>` | LLM provider |
| `--embedding-provider` | `<name>` | Embedding provider |
| `--rebuild-embeddings` | | Drop + recreate vector table at current dimension |
| `--concurrency-drive` | `<N>` | Max parallel Drive API calls (default: 15) |
| `--concurrency-llm` | `<N>` | Max parallel LLM/embedding calls (default: 4) |
| `--concurrency` | `<N>` | Shorthand for `--concurrency-drive` |
| `--max-size` | `<bytes>` | Skip files larger than this (default: 20971520) |
| `--max-pdf-pages` | `<N>` | Slice PDFs to first N pages (default: 10) |
| `--root` | `<FOLDER_ID>` | One-shot root override (bypasses config) |
| `--add-root` | | Persist the resolved root to config |

LLM providers: `anthropic` (default), `openai`, `ollama`

Embedding providers: `openai` (default), `voyage`, `ollama`

```bash
# Index a folder with defaults
gdrivescope --json index --scope FOLDER_ID | jq '.data'

# Metadata-only (fast, free)
gdrivescope --json index --scope FOLDER_ID --metadata-only | jq '.data'

# Resume after interruption
gdrivescope --json index --scope FOLDER_ID --resume | jq '.data'

# Prune + resume combo
gdrivescope --json index --scope FOLDER_ID --resume --prune | jq '.data'

# Custom providers
gdrivescope --json index --scope FOLDER_ID --provider openai --embedding-provider voyage | jq '.data'

# Rebuild embeddings at new dimension
gdrivescope --json index --scope FOLDER_ID --embedding-provider voyage --rebuild-embeddings | jq '.data'

# Throttle concurrency
gdrivescope --json index --scope FOLDER_ID --concurrency-drive 5 --concurrency-llm 2 | jq '.data'
```

## Config

```
gdrivescope config show
gdrivescope config list-roots
gdrivescope config add-root <FOLDER_ID> [flags]
gdrivescope config remove-root <FOLDER_ID>
```

| Flag | Args | Purpose |
|------|------|---------|
| `--label` | `<name>` | Display label for `add-root` |

```bash
# Show workspace config
gdrivescope --json config show | jq '.data'

# List roots with node counts
gdrivescope --json config list-roots | jq '.data[] | {id, label, node_count}'

# Add a root with label
gdrivescope --json config add-root FOLDER_ID --label "Shared Drive" | jq '.data'

# Remove a root
gdrivescope --json config remove-root FOLDER_ID | jq '.data'
```

## File

### file list

```
gdrivescope file list [FOLDER_ID] [flags]
```

| Flag | Args | Purpose |
|------|------|---------|
| `-r, --recursive` | | Recurse into subfolders |
| `--limit` | `<N>` | Max rows (default: 200) |

```bash
# List root
gdrivescope --json file list | jq '.data[] | {id, name}'

# List folder recursively
gdrivescope --json file list FOLDER_ID -r | jq '.data[] | {id, name, mime_type}'

# Limit output
gdrivescope --json file list FOLDER_ID -r --limit 50 | jq '.data | length'
```

### file show

```
gdrivescope file show <ID>
```

```bash
gdrivescope --json file show FILE_ID | jq '.data | {name, path, mime_type, summary, key_topics}'
```

### file search

```
gdrivescope file search <QUERY> [flags]
```

| Flag | Args | Purpose |
|------|------|---------|
| `--mode` | `name\|semantic` | Search backend (default: auto) |
| `--scope` | `<FOLDER_ID>` | Restrict to descendants of folder |
| `--limit` | `<N>` | Max hits (default: 20) |
| `--threshold` | `<X>` | Min cosine similarity (semantic only) |
| `--classification` | `<value>` | Filter by classification |
| `--embedding-provider` | `<name>` | Embedding provider for query |

Search modes: `semantic` (cosine similarity over embeddings), `name` (substring match on file name). Default: auto — semantic if embeddings exist, else name.

```bash
# Semantic search
gdrivescope --json file search "quarterly revenue" --limit 5 | jq '.data[] | {name, path, score}'

# Scoped semantic search
gdrivescope --json file search "budget" --scope FOLDER_ID --threshold 0.7 | jq '.data[] | {name, score}'

# Name-based search
gdrivescope --json file search "report" --mode name | jq '.data[] | {name, path}'

# Filter by classification
gdrivescope --json file search "design" --classification spreadsheet | jq '.data[] | {name, path}'
```

### file download

```
gdrivescope file download <ID> [flags]
```

| Flag | Args | Purpose |
|------|------|---------|
| `-o, --output` | `<path>` | Destination file or directory (default: cwd) |
| `--format` | `auto\|raw` | Export format (default: auto) |

Formats: `auto` (export Google Workspace docs via export map), `raw` (binary bytes).

```bash
# Download to current directory
gdrivescope --json file download FILE_ID | jq '.data | {path, bytes}'

# Download to specific path
gdrivescope --json file download FILE_ID -o ./reports/q4.pdf | jq '.data | {path, bytes}'

# Download raw bytes (skip export conversion)
gdrivescope --json file download FILE_ID --format raw | jq '.data | {path, bytes}'
```

## Global Flags

| Flag | Purpose |
|------|---------|
| `--json` | Structured JSON envelope output |
| `-h, --help` | Show help |
| `-v, --version` | Print version |
