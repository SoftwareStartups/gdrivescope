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
| `--concurrency-llm` | `<N>` | Max parallel LLM/embedding calls (default: 4; 1 when provider is `ollama`) |
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

## Ollama

```
gdrivescope ollama setup [flags]
```

Probes a running Ollama instance, pulls any missing models, validates chat and
embedding endpoints, then writes the chosen settings into `config.toml`.

| Flag | Args | Purpose |
|------|------|---------|
| `--host` | `<URL>` | Ollama base URL (default `http://localhost:11434`) |
| `--llm-model` | `<NAME>` | LLM model to install (default `llama3.2:3b`) |
| `--embedding-model` | `<NAME>` | Embedding model (default `nomic-embed-text`) |
| `--skip-pull` | | Assume models are already installed |

```bash
# Default setup: pull llama3.2:3b + nomic-embed-text, write config
gdrivescope --json ollama setup | jq '.data'

# Custom host + model
gdrivescope --json ollama setup --host http://remote:11434 --llm-model llama3.1:8b | jq '.data'

# Skip model pull (models already present)
gdrivescope --json ollama setup --skip-pull | jq '.data'
```

## Graph

### list

```
gdrivescope list [FOLDER_ID] [flags]
```

| Flag | Args | Purpose |
|------|------|---------|
| `-r, --recursive` | | Recurse into subfolders |
| `--type` | `folder\|file\|shortcut\|other` | Filter by node kind |
| `--limit` | `<N>` | Max rows (default: 200) |

Node kinds: `folder` (Drive folders), `file` (extractable content — Docs, PDFs, Office), `shortcut` (Drive shortcuts), `other` (forms / sites / images / audio / video).

```bash
# List root
gdrivescope --json list | jq '.data.files[] | {id, name}'

# List folder recursively
gdrivescope --json list FOLDER_ID -r | jq '.data.files[] | {id, name, mime_type}'

# Only folders
gdrivescope --json list FOLDER_ID -r --type folder | jq '.data.files[] | {id, name}'

# Only extractable files
gdrivescope --json list FOLDER_ID -r --type file | jq '.data.files[] | {id, name, mime_type}'

# Limit output
gdrivescope --json list FOLDER_ID -r --limit 50 | jq '.data.files | length'
```

### show

```
gdrivescope show <ID>
```

```bash
gdrivescope --json show FILE_ID | jq '.data | {name: .node.name, path, mime: .node.mime_type, summary: .node.summary, key_topics: .node.key_topics}'
```

### search

```
gdrivescope search <QUERY> [flags]
```

| Flag | Args | Purpose |
|------|------|---------|
| `--mode` | `name\|semantic` | Search backend (default: auto) |
| `--type` | `folder\|file\|shortcut\|other` | Filter by node kind |
| `--scope` | `<FOLDER_ID>` | Restrict to descendants of folder |
| `--limit` | `<N>` | Max hits (default: 20) |
| `--threshold` | `<X>` | Min cosine similarity (semantic only) |
| `--classification` | `<value>` | Filter by classification |
| `--embedding-provider` | `<name>` | Embedding provider for query |

Search modes: `semantic` (cosine similarity over embeddings), `name` (substring match on entry name). Default: auto — semantic if embeddings exist, else name. Only `--type file` entries are embedded; pair `--type folder|shortcut|other` with `--mode name`.

```bash
# Semantic search
gdrivescope --json search "quarterly revenue" --limit 5 | jq '.data.hits[] | {name, path, score}'

# Scoped semantic search
gdrivescope --json search "budget" --scope FOLDER_ID --threshold 0.7 | jq '.data.hits[] | {name, score}'

# Name-based search
gdrivescope --json search "report" --mode name | jq '.data.hits[] | {name, path}'

# Find a folder by name
gdrivescope --json search "Reports" --mode name --type folder | jq '.data.hits[] | {id, name, path}'

# Filter by classification
gdrivescope --json search "design" --classification financial | jq '.data.hits[] | {name, path}'
```

### download

```
gdrivescope download <ID> [flags]
```

| Flag | Args | Purpose |
|------|------|---------|
| `-o, --output` | `<path>` | Destination file or directory (default: cwd) |
| `--format` | `auto\|raw` | Export format (default: auto) |

Formats: `auto` (export Google Workspace docs via export map), `raw` (binary bytes).

```bash
# Download to current directory
gdrivescope --json download FILE_ID | jq '.data | {output_path, bytes}'

# Download to specific path
gdrivescope --json download FILE_ID -o ./reports/q4.pdf | jq '.data | {output_path, bytes}'

# Download raw bytes (skip export conversion)
gdrivescope --json download FILE_ID --format raw | jq '.data | {output_path, bytes}'
```

## Global Flags

| Flag | Purpose |
|------|---------|
| `--json` | Structured JSON envelope output |
| `-h, --help` | Show help |
| `-v, --version` | Print version |
