# gdrivescope

A Bun-native TypeScript CLI for Google Drive: traverse folders into a local graph, extract and summarize documents via pluggable LLM + embedding providers, and run semantic search — all from your terminal or AI agent.

## What is it?

`gdrivescope` indexes Google Drive folders into a single local SQLite database. Each file is downloaded, its content extracted to markdown, summarized and classified by an LLM, and embedded for vector search. The result is a searchable local knowledge base of your Drive, usable from the command line or through AI agents via `--json`.

Key features:

- OAuth login via the browser (loopback + PKCE, credentials in OS keychain)
- BFS traversal of Drive folder trees with bounded-parallel API calls
- Content extraction to markdown via Kreuzberg (PDF, Office, and 50+ formats)
- Google Workspace files (Docs, Sheets, Slides) exported server-side as text/CSV
- Summarization and classification via Anthropic, OpenAI, or local Ollama
- Vector embeddings (OpenAI, Voyage, or Ollama) stored in sqlite-vec for semantic search
- Single standalone binary — no Python, Docker, or system library dependencies

## Installation

### From GitHub Releases

Download a pre-compiled binary for your platform from [GitHub Releases](https://github.com/SoftwareStartups/gdrivescope/releases):

```bash
# macOS (Apple Silicon)
curl -L https://github.com/SoftwareStartups/gdrivescope/releases/latest/download/gdrivescope-darwin-arm64 -o gdrivescope
chmod +x gdrivescope
sudo mv gdrivescope /usr/local/bin/

# macOS (Intel)
curl -L https://github.com/SoftwareStartups/gdrivescope/releases/latest/download/gdrivescope-darwin-x64 -o gdrivescope

# Linux (x64)
curl -L https://github.com/SoftwareStartups/gdrivescope/releases/latest/download/gdrivescope-linux-x64 -o gdrivescope

# Linux (ARM64)
curl -L https://github.com/SoftwareStartups/gdrivescope/releases/latest/download/gdrivescope-linux-arm64 -o gdrivescope
```

Verify the download:

```bash
sha256sum gdrivescope  # compare against checksums in the release
chmod +x gdrivescope
```

### From source

Prerequisites: [Bun](https://bun.sh) and [Task](https://taskfile.dev)

```bash
git clone https://github.com/SoftwareStartups/gdrivescope.git
cd gdrivescope
bun install
task compile
./dist/gdrivescope --help
```

## Auth quickstart

```bash
# 1. Set your Google OAuth credentials (create at https://console.cloud.google.com/apis/credentials)
export GOOGLE_OAUTH_CLIENT_ID="your-client-id"
export GOOGLE_OAUTH_CLIENT_SECRET="your-client-secret"

# 2. Log in — opens a browser for OAuth consent, stores the refresh token in your OS keychain
gdrivescope login

# 3. Verify with a quick metadata-only index of a small folder
gdrivescope index --scope <FOLDER_ID> --metadata-only
```

Credentials are stored in the OS keychain via the Bun Secrets API. `gdrivescope logout` clears them.

## Commands

| Command | Purpose |
|---|---|
| `gdrivescope login` | OAuth loopback flow, store refresh token in OS keychain |
| `gdrivescope logout` | Clear stored credentials |
| `gdrivescope index` | Traverse + extract + summarize + embed |
| `gdrivescope config show` | Print the workspace config |
| `gdrivescope config list-roots` | List configured root folders |
| `gdrivescope config add-root` | Persist a Drive folder as a root |
| `gdrivescope config remove-root` | Remove a configured root |
| `gdrivescope file list [FOLDER_ID]` | Tree listing from the local graph |
| `gdrivescope file show <ID>` | Node details (path, metadata, summary, topics) |
| `gdrivescope file search <QUERY>` | Semantic + filter search via sqlite-vec |
| `gdrivescope file download <ID>` | Raw bytes to disk |

### Index flags

```
--scope <FOLDER_ID>          Start folder (default: configured root)
--metadata-only              Skip extraction + LLM + embeddings (free, fast, safe)
--resume                     Only process files without a summary or with errors
--prune                      Delete rows for files no longer visible in Drive
--concurrency-drive <N>      Max parallel Drive API calls (default 15)
--concurrency-llm <N>        Max parallel LLM/embedding API calls (default 4)
--concurrency <N>            Shorthand for --concurrency-drive
--provider <NAME>            LLM provider: anthropic | openai | ollama
--embedding-provider <NAME>  Embedding provider: openai | voyage | ollama
--rebuild-embeddings         Drop + recreate the vector table
--max-size <BYTES>           Skip files larger than this (default 20MB)
--max-pdf-pages <N>          Slice PDFs to first N pages (default 10)
```

### Start with `--metadata-only`

The `--metadata-only` flag skips all downloads, extraction, LLM calls, and embedding. It only traverses Drive metadata and populates the graph — completely free, fast, and safe. Use it to explore a new Drive folder before committing to a full index run with API costs:

```bash
# Safe: explore structure at zero cost
gdrivescope index --scope <FOLDER_ID> --metadata-only

# Then browse what's there
gdrivescope file list <FOLDER_ID> -r

# When ready, full-index with summarization + embeddings
gdrivescope index --scope <FOLDER_ID>
```

## Global options

| Flag | Description |
|---|---|
| `--json` | Emit structured `{ok, data}` / `{ok, error, code}` envelope |
| `--version`, `-v` | Print version |
| `--help`, `-h` | Show help |

## Environment variables

| Variable | Purpose |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth client id (required for `login`) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret (required for `login`) |
| `ANTHROPIC_API_KEY` | Anthropic LLM provider |
| `OPENAI_API_KEY` | OpenAI LLM / embedding provider |
| `VOYAGE_API_KEY` | Voyage embedding provider |
| `GDRIVESCOPE_LLM_PROVIDER` | `anthropic` \| `openai` \| `ollama` |
| `GDRIVESCOPE_EMBEDDING_PROVIDER` | `openai` \| `voyage` \| `ollama` |
| `GDRIVESCOPE_OLLAMA_HOST` | Ollama base URL (default `http://localhost:11434`) |
| `GDRIVESCOPE_OLLAMA_MODEL` | Ollama chat model |
| `GDRIVESCOPE_OLLAMA_EMBEDDING_MODEL` | Ollama embedding model |
| `GDRIVESCOPE_OLLAMA_EMBEDDING_DIMENSIONS` | Ollama embedding vector size |
| `GDRIVESCOPE_MAX_SIZE` | Default `--max-size` value |
| `GDRIVESCOPE_MAX_PDF_PAGES` | Default `--max-pdf-pages` value |

## Configuration

Workspace config lives at `~/.config/gdrivescope/config.toml`:

```toml
[llm]
provider = "anthropic"      # anthropic | openai | ollama

[embedding]
provider = "openai"         # openai | voyage | ollama

[extraction]
maxSizeBytes = 20971520     # 20 MB
maxPdfPages = 10

[[roots]]
id = "1ABC..."
label = "Team Drive"
```

Manage roots via `gdrivescope config add-root <FOLDER_ID>` / `config remove-root`.

## Troubleshooting

**Auth errors** — Run `gdrivescope logout` then `gdrivescope login` to re-authorize. Ensure `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` are set. The OAuth client must have the `drive.readonly` scope enabled in the Google Cloud console.

**Kreuzberg extraction failures** — Kreuzberg uses NAPI bindings for PDF/Office extraction. If they fail at runtime (e.g. on a musl-based Linux or inside a stripped container), the tool falls back to `@kreuzberg/wasm`. If both fail, the file is skipped with an error recorded in `last_error`.

**Provider selection** — The LLM provider resolves in order: `--provider` flag > `GDRIVESCOPE_LLM_PROVIDER` env > `config.toml [llm].provider` > `anthropic`. Embedding provider follows the same cascade defaulting to `openai`.

**Rebuild embeddings** — If you switch embedding providers (e.g. from OpenAI to Voyage), the vector dimensions change. Pass `--rebuild-embeddings` on the next full index run to drop and recreate the vector table.

**Ollama** — Set `GDRIVESCOPE_LLM_PROVIDER=ollama` and `GDRIVESCOPE_EMBEDDING_PROVIDER=ollama`, then configure the model names via `GDRIVESCOPE_OLLAMA_MODEL` and `GDRIVESCOPE_OLLAMA_EMBEDDING_MODEL`. Ensure your Ollama instance is running at `GDRIVESCOPE_OLLAMA_HOST` (default `http://localhost:11434`).

## Development

```bash
bun install           # Install dependencies
task build            # Compile TypeScript to build/
task lint             # Lint with Biome
task format           # Format with Biome
task test             # Run unit + integration tests
task test:unit        # Unit tests only
task test:integration # Integration tests only
task check            # Lint + typecheck + tests
task ci               # Full CI pipeline locally
task compile          # Build standalone binary to dist/
task compile:all      # Build all 6 platform binaries
```

## License

MIT — see [LICENSE](LICENSE).
