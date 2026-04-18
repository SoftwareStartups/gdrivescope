# gdrivescope

A Bun-native TypeScript CLI for Google Drive: traverse folders into a local graph, extract and summarize documents via pluggable LLM + embedding providers, and run semantic search — all from your terminal or AI agent.

## What is it?

`gdrivescope` indexes Google Drive folders into a single local SQLite database. Each file is downloaded, its content extracted to markdown, summarized and classified by an LLM, and embedded for vector search. The result is a searchable local knowledge base of your Drive, usable from the command line or through AI agents via `--json`.

Key features:

- OAuth login via the browser (loopback + PKCE, credentials in OS keychain)
- BFS traversal of Drive folder trees with bounded-parallel API calls
- Content extraction to markdown via Kreuzberg (PDF, Office, and 50+ formats)
- Google Workspace files (Docs, Sheets, Slides) exported server-side as text/CSV
- Summarization and classification via Anthropic, OpenAI, or Azure OpenAI
- Vector embeddings (OpenAI, Azure OpenAI, or Voyage) stored in sqlite-vec for semantic search
- Single standalone binary (requires system SQLite with extension support — see [Prerequisites](#prerequisites))

## Prerequisites

### SQLite with extension support

gdrivescope uses [sqlite-vec](https://github.com/asg017/sqlite-vec) for vector search. Bun's bundled SQLite does not support loading extensions, so a system SQLite library is required at runtime.

**macOS (Homebrew):**

```bash
brew install sqlite
```

Homebrew's sqlite is keg-only. gdrivescope automatically loads `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`.

**Linux:**

```bash
# Debian / Ubuntu
sudo apt install libsqlite3-0

# Fedora / RHEL
sudo dnf install sqlite-libs
```

gdrivescope loads `libsqlite3.so.0` from the system library path.

**Custom path:**

```bash
export GDRIVESCOPE_SQLITE_LIB=/path/to/libsqlite3.so
```

### Google OAuth credentials

Create a **Desktop** OAuth client at [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials). Enable the **Google Drive API** for your project and add the `drive.readonly` scope.

You will need the client id and secret for `gdrivescope login`.

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

## Getting started

### Step 1: Log in

```bash
gdrivescope login
```

The login command resolves your Google OAuth client id and secret through a cascade:

1. `--client-id` / `--client-secret` flags
2. `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` environment variables
3. OS keychain (populated by a previous login)
4. Interactive prompt (TTY only — paste when asked)

On first login you can set env vars, pass flags, or just run `gdrivescope login` and paste the credentials when prompted. After login, credentials are stored in the OS keychain and reused automatically.

No API keys (Anthropic, OpenAI, etc.) are needed for login.

### Step 2: Explore with metadata-only

```bash
gdrivescope index --scope <FOLDER_ID> --metadata-only
gdrivescope list <FOLDER_ID> -r
```

`--metadata-only` traverses the Drive folder tree and populates the local graph without downloading files, calling LLMs, or generating embeddings. It is free, fast, and safe — use it to see what is in a folder before committing to a full index run.

### Step 3: Set up API keys for full indexing

A full index run downloads files, extracts content, summarizes via an LLM, and generates vector embeddings. This requires API keys for the configured providers.

**Default configuration** (Anthropic for LLM + OpenAI for embeddings):

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
```

**OpenAI for both LLM and embeddings:**

```bash
export OPENAI_API_KEY="sk-..."
gdrivescope index --scope <FOLDER_ID> --provider openai
```

**Anthropic for LLM + Voyage for embeddings:**

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export VOYAGE_API_KEY="pa-..."
gdrivescope index --scope <FOLDER_ID> --embedding-provider voyage
```

See [Provider configuration](#provider-configuration) for the full resolution cascade and scenario matrix.

### Step 4: Full index

```bash
gdrivescope index --scope <FOLDER_ID>
```

### Step 5: Search

```bash
gdrivescope search "board meeting Q3"
```

## Root folders

Root folders are stable anchor points in your Drive hierarchy. When you index a subfolder with `--scope`, gdrivescope walks up the folder tree to find a matching root, then stitches the ancestor chain (root → … → scope) into the graph. This keeps file paths consistent across index runs that target different scopes.

**Add a root:**

```bash
gdrivescope config add-root <FOLDER_ID> --label "Team Drive"
```

**List configured roots:**

```bash
gdrivescope config list-roots
```

**Remove a root:**

```bash
gdrivescope config remove-root <FOLDER_ID>
```

If `--scope` points to a folder that is not under any configured root, gdrivescope warns and indexes it as a standalone tree. You can add it later with `config add-root`.

Roots are stored in `~/.config/gdrivescope/config.toml`:

```toml
[[roots]]
id = "1ABC..."
label = "Team Drive"
```

## Commands

| Command | Purpose |
|---|---|
| `login` | OAuth loopback flow, store refresh token in OS keychain |
| `logout` | Clear stored credentials |
| `index` | Traverse + extract + summarize + embed |
| `config show` | Print the workspace config |
| `config list-roots` | List configured root folders |
| `config add-root` | Persist a Drive folder as a root |
| `config remove-root` | Remove a configured root |
| `list [FOLDER_ID]` | Tree listing from the local graph (`--type folder\|file\|shortcut\|other` to filter) |
| `show <ID>` | Node details (path, metadata, summary, topics) |
| `search <QUERY>` | Semantic + filter search via sqlite-vec (`--type` filter supported) |
| `download <ID>` | Raw bytes to disk |

## Index flags

```text
--scope <FOLDER_ID>          Start folder (default: configured root)
--root <FOLDER_ID>           One-shot root override (bypasses config.toml)
--add-root                   Persist the resolved root to config.toml
--metadata-only              Skip extraction + LLM + embeddings (free, fast, safe)
--resume                     Only process files without a summary or with errors
--prune                      Delete rows for files no longer visible in Drive
--concurrency-drive <N>      Max parallel Drive API calls (default 15)
--concurrency-llm <N>        Max parallel LLM/embedding API calls (default 4)
--concurrency <N>            Shorthand for --concurrency-drive
--provider <NAME>            LLM provider: anthropic | openai | azure-openai | ollama
--embedding-provider <NAME>  Embedding provider: openai | azure-openai | voyage | ollama
--rebuild-embeddings         Drop + recreate the vector table
--max-size <BYTES>           Skip files larger than this (default 20 MB)
--max-pdf-pages <N>          Slice PDFs to first N pages (default 10)
```

### Concurrency

The index command uses two independent semaphores:

- **`--concurrency-drive`** (default 15) controls parallel Google Drive API calls — metadata listing, file downloads, and Workspace exports.
- **`--concurrency-llm`** (default 4) controls parallel LLM summarization and embedding calls.

Both run concurrently: you can have 15 Drive downloads in flight while 4 LLM calls are being processed. The Drive default is higher because those calls are cheap and fast; the LLM default is lower to stay within typical API rate limits. `--concurrency` is shorthand for `--concurrency-drive`.

### Start with `--metadata-only`

The `--metadata-only` flag skips all downloads, extraction, LLM calls, and embedding. It only traverses Drive metadata and populates the graph — completely free, fast, and safe. Use it to explore a new Drive folder before committing to a full index run with API costs:

```bash
# Safe: explore structure at zero cost
gdrivescope index --scope <FOLDER_ID> --metadata-only

# Then browse what's there
gdrivescope list <FOLDER_ID> -r

# When ready, full-index with summarization + embeddings
gdrivescope index --scope <FOLDER_ID>
```

## Provider configuration

gdrivescope uses two separate providers: an **LLM provider** for summarization and classification, and an **embedding provider** for vector search. Each is resolved independently through the same cascade:

**CLI flag → environment variable → config.toml → auto-inference from API keys**

When no provider is explicitly configured, gdrivescope scans available API keys and auto-selects the first viable provider. LLM priority: Anthropic → OpenAI → Azure OpenAI → Ollama. Embedding priority: OpenAI → Azure OpenAI → Voyage → Ollama.

| | LLM (summarization) | Embedding (vector search) |
|---|---|---|
| **Available** | `anthropic`, `openai`, `azure-openai`, `ollama` | `openai`, `azure-openai`, `voyage`, `ollama` |
| **CLI flag** | `--provider` | `--embedding-provider` |
| **Env var** | `GDRIVESCOPE_LLM_PROVIDER` | `GDRIVESCOPE_EMBEDDING_PROVIDER` |
| **Config key** | `[llm] provider` | `[embedding] provider` |
| **Config model** | `[llm] model` | `[embedding] model` |

### API keys by scenario

| Scenario | Keys needed |
|---|---|
| Login | None (Google OAuth credentials resolved via flags / env / keychain / prompt) |
| Metadata-only index | None |
| Full index (Anthropic + OpenAI) | `ANTHROPIC_API_KEY` + `OPENAI_API_KEY` |
| Full index (OpenAI for both) | `OPENAI_API_KEY` |
| Full index (Anthropic + Voyage) | `ANTHROPIC_API_KEY` + `VOYAGE_API_KEY` |
| Full index (Azure OpenAI) | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` |
| Semantic search | Same embedding provider key used during indexing |

### Azure OpenAI

For corporate environments using Azure OpenAI:

```bash
export AZURE_OPENAI_API_KEY="your-key"
export AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com"
gdrivescope index --scope <FOLDER_ID> --provider azure-openai --embedding-provider azure-openai
```

Optional: set deployment names and API version via environment variables or config.toml:

```bash
export AZURE_OPENAI_LLM_DEPLOYMENT="gpt-4"
export AZURE_OPENAI_EMBEDDING_DEPLOYMENT="text-embedding-3-small"
export AZURE_OPENAI_API_VERSION="2024-06-01"
```

Or in config.toml:

```toml
[azure]
endpoint = "https://your-resource.openai.azure.com"
api_version = "2024-06-01"
llm_deployment = "gpt-4"
embedding_deployment = "text-embedding-3-small"
```

### Switching embedding providers

If you switch embedding providers (e.g. from OpenAI to Voyage), the vector dimensions change. Pass `--rebuild-embeddings` on the next full index run to drop and recreate the vector table.

## Global options

| Flag | Description |
|---|---|
| `--json` | Emit structured `{ok, data}` / `{ok, error, code}` envelope |
| `--version`, `-v` | Print version |
| `--help`, `-h` | Show help |

## Environment variables

### Google OAuth

| Variable | Purpose |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth client id (one of four ways to provide it — see [Getting started](#step-1-log-in)) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret |

### API keys

| Variable | Required when |
|---|---|
| `ANTHROPIC_API_KEY` | Using `anthropic` LLM provider |
| `OPENAI_API_KEY` | Using `openai` LLM provider or `openai` embedding provider |
| `VOYAGE_API_KEY` | Using `voyage` embedding provider |
| `AZURE_OPENAI_API_KEY` | Using `azure-openai` LLM or embedding provider |
| `AZURE_OPENAI_ENDPOINT` | Using `azure-openai` provider (resource endpoint) |
| `AZURE_OPENAI_API_VERSION` | Azure API version override (default `2024-06-01`) |
| `AZURE_OPENAI_LLM_DEPLOYMENT` | Azure deployment name for LLM |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | Azure deployment name for embeddings |

### Defaults and overrides

| Variable | Purpose |
|---|---|
| `GDRIVESCOPE_LLM_PROVIDER` | Default LLM provider (`anthropic`, `openai`, `azure-openai`, `ollama`) |
| `GDRIVESCOPE_EMBEDDING_PROVIDER` | Default embedding provider (`openai`, `azure-openai`, `voyage`, `ollama`) |
| `GDRIVESCOPE_SQLITE_LIB` | Custom path to a SQLite library with extension support |
| `GDRIVESCOPE_MAX_SIZE` | Default `--max-size` value (bytes) |
| `GDRIVESCOPE_MAX_PDF_PAGES` | Default `--max-pdf-pages` value |
| `GDRIVESCOPE_DB` | Custom database path (default `~/.config/gdrivescope/drive.db`) |
| `GDRIVESCOPE_CONFIG` | Custom config path (default `~/.config/gdrivescope/config.toml`) |

## Configuration

Workspace config lives at `~/.config/gdrivescope/config.toml`:

```toml
[llm]
provider = "anthropic"      # anthropic | openai | azure-openai | ollama
model = "claude-sonnet-4-6" # optional model override

[embedding]
provider = "openai"         # openai | azure-openai | voyage | ollama
model = "text-embedding-3-small"

[azure]
endpoint = "https://your-resource.openai.azure.com"
api_version = "2024-06-01"
llm_deployment = "gpt-4"
embedding_deployment = "text-embedding-3-small"

[extraction]
max_size_bytes = 20971520   # 20 MB
max_pdf_pages = 10

[[roots]]
id = "1ABC..."
label = "Team Drive"
```

Manage roots via `gdrivescope config add-root` / `config remove-root`.

## Troubleshooting

**SQLite extension error** — If you see `Failed to load sqlite-vec extension`, install a system SQLite library with extension support for your platform (see [Prerequisites](#sqlite-with-extension-support)) or set `GDRIVESCOPE_SQLITE_LIB` to a capable libsqlite path.

**Auth errors** — Run `gdrivescope logout` then `gdrivescope login` to re-authorize. Ensure your Google OAuth client has the `drive.readonly` scope enabled in the Google Cloud console.

**Kreuzberg extraction failures** — Kreuzberg uses NAPI bindings for PDF/Office extraction. If they fail at runtime (e.g. on a musl-based Linux or inside a stripped container), the tool falls back to `@kreuzberg/wasm`. If both fail, the file is skipped with an error recorded in `last_error`.

**Provider selection** — The LLM provider resolves in order: `--provider` flag > `GDRIVESCOPE_LLM_PROVIDER` env > `config.toml [llm].provider` > auto-infer from available API keys. Embedding provider follows the same cascade. If no provider is explicitly configured, gdrivescope scans for available API keys and selects the first match.

**Rebuild embeddings** — If you switch embedding providers (e.g. from OpenAI to Voyage), the vector dimensions change. Pass `--rebuild-embeddings` on the next full index run to drop and recreate the vector table.

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
