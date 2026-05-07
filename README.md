# gdrivescope

A native Rust CLI for Google Drive: traverse folders into a local graph, extract and summarize documents via pluggable LLM + embedding providers, and run semantic search — all from your terminal or AI agent.

## What is it?

`gdrivescope` indexes Google Drive folders into a single local SQLite database. Each file is downloaded, its content extracted to markdown, summarized and classified by an LLM, and embedded for vector search. The result is a searchable local knowledge base of your Drive, usable from the command line or through AI agents via `--json`.

Key features:

- OAuth login via the browser (loopback + PKCE, credentials in OS keychain)
- BFS traversal of Drive folder trees with bounded-parallel API calls
- Content extraction to markdown via Kreuzberg (PDF, Office, and 50+ formats)
- Pure-Rust PDF extraction via pdf-oxide — no libpdfium runtime dependency
- Google Workspace files (Docs, Sheets, Slides) exported server-side as text/CSV
- Summarization and classification via Anthropic, OpenAI, or Azure OpenAI
- Vector embeddings (OpenAI, Azure OpenAI, or Voyage) stored in sqlite-vec for semantic search
- Single static binary — bundled SQLite + sqlite-vec, no system libsqlite3 / libpdfium / OpenSSL required

## Prerequisites

### Google OAuth credentials

Create a **Desktop** OAuth client at [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) and enable the **Google Drive API** for your project. You will need the client id and secret for `gdrivescope login`.

#### OAuth consent screen scopes

gdrivescope uses two Drive scopes depending on what you ask it to do:

| Scope | What it allows | Commands that need it |
|-------|----------------|-----------------------|
| `https://www.googleapis.com/auth/drive.metadata.readonly` | List folders, read file metadata (name, size, mime, path, ancestry) | `list`, `config *`, `index --metadata-only` |
| `https://www.googleapis.com/auth/drive.readonly` | Everything `drive.metadata.readonly` grants, plus download file content and export Google Workspace docs | `index` (default), `download`, `show`, `search` — and any metadata-only command above |

`drive.readonly` is a superset of `drive.metadata.readonly`: a session authorized with `drive.readonly` can run every command, including `--metadata-only` flows, without re-logging in.

In Cloud Console → **APIs & Services → OAuth consent screen → Scopes**, add both scopes. `drive.readonly` is the one required for content indexing; without it, `files.get?alt=media` and `files.export` return HTTP 403 `appNotAuthorizedToFile` for every file.

If your OAuth app is in **Testing** mode, also add yourself (and any other accounts you plan to use) as a Test user. For production use, Google requires verification for sensitive scopes like `drive.readonly`.

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

Prerequisites: a Rust toolchain. The repo's `rust-toolchain.toml` pins MSRV 1.85; install [rustup](https://rustup.rs/) and it will fetch the right channel automatically.

```bash
git clone https://github.com/SoftwareStartups/gdrivescope.git
cd gdrivescope
cargo build --release
./target/release/gdrivescope --help
```

## Use with Claude Code

This repo is a Claude Code plugin marketplace. Install the companion skill so Claude Code can drive `gdrivescope` for you:

```bash
/plugin marketplace add SoftwareStartups/gdrivescope
/plugin install gdrivescope@softwarestartups-gdrivescope
```

Once installed, just ask Claude in plain language (e.g., "Search my Drive for the contract draft") and the skill will activate automatically. The plugin tracks this repo's releases — run `/plugin marketplace update softwarestartups-gdrivescope` to get the latest skill revisions.

## Getting started

### Step 1: Log in

```bash
# Exploration only (list, index --metadata-only)
gdrivescope login

# Full indexing (downloads + summarization + embeddings)
gdrivescope login --scope drive.readonly
```

The default `gdrivescope login` requests only the `drive.metadata.readonly` scope, which is enough to list folders and read file metadata. To download file content — required by `index` without `--metadata-only`, `download`, `show`, and any search that renders content — re-run with `--scope drive.readonly`. That broader scope also covers every metadata-only flow, so once you have it you never need to re-login just to run `--metadata-only`. Running content-downloading commands against a metadata-only session fails fast with a `SCOPE_REQUIRED` error.

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
| `ollama setup` | Configure local Ollama (pull models, validate endpoints, write config) |

## Index flags

```text
--scope <FOLDER_ID>          Start folder (default: configured root)
--root <FOLDER_ID>           One-shot root override (bypasses config.toml)
--add-root                   Persist the resolved root to config.toml
--metadata-only              Skip extraction + LLM + embeddings (free, fast, safe)
--resume                     Only process files without a summary or with errors
--prune                      Delete rows for files no longer visible in Drive
--concurrency-drive <N>      Max parallel Drive API calls (default 15)
--concurrency-llm <N>        Max parallel LLM/embedding API calls (default 4; 1 for ollama)
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
- **`--concurrency-llm`** (default 4; `1` when the LLM provider is `ollama`) controls parallel LLM summarization and embedding calls.

Both run concurrently: you can have 15 Drive downloads in flight while 4 LLM calls are being processed. The Drive default is higher because those calls are cheap and fast; the LLM default is lower to stay within typical API rate limits. Local Ollama serializes inference per model, so the LLM default drops to 1 — passing `--concurrency-llm N` with `N>1` against Ollama still works but emits an info line because it mostly adds queueing latency. `--concurrency` is shorthand for `--concurrency-drive`.

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

### Ollama (local)

For fully local indexing with no API keys:

```bash
# 1. Install + start Ollama
brew install ollama
brew services start ollama     # or: ollama serve &

# 2. Pull the models you'll use (one-time)
ollama pull llama3.2:3b        # LLM — default for GDRIVESCOPE_OLLAMA_MODEL
ollama pull nomic-embed-text   # embeddings

# 3. Run the index
gdrivescope index --scope <FOLDER_ID> --provider ollama --embedding-provider ollama
```

**Keep the model resident.** Ollama unloads models after `keep_alive` expires (default 5 minutes). If a cold load happens between every summarize call, indexing appears to hang — each PDF waits several seconds for the model to reload. Options:

```bash
# Pin the model in RAM for the whole session (recommended for long index runs)
OLLAMA_KEEP_ALIVE=-1 ollama serve

# Or warm it once before starting the index so it stays loaded under the
# default 5-minute window (extended by each gdrivescope call)
ollama run llama3.2:3b "" >/dev/null
```

Check what's loaded with `ollama ps` — if the list is empty during a run, the model is cold-loading per request.

Override host or model via env vars:

```bash
export GDRIVESCOPE_OLLAMA_HOST="http://localhost:11434"
export GDRIVESCOPE_OLLAMA_MODEL="llama3.2:3b"
export GDRIVESCOPE_OLLAMA_EMBEDDING_MODEL="nomic-embed-text"
export GDRIVESCOPE_OLLAMA_EMBEDDING_DIMENSIONS="768"   # must match the embedding model
```

If you change the embedding model later, the vector dimensions change — pass `--rebuild-embeddings` on the next index run.

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

### Provider defaults

| Variable | Purpose |
|---|---|
| `GDRIVESCOPE_LLM_PROVIDER` | Default LLM provider (`anthropic`, `openai`, `azure-openai`, `ollama`) |
| `GDRIVESCOPE_EMBEDDING_PROVIDER` | Default embedding provider (`openai`, `azure-openai`, `voyage`, `ollama`) |

### Provider model overrides

| Variable | Purpose |
|---|---|
| `GDRIVESCOPE_ANTHROPIC_MODEL` | Anthropic LLM model override (default `claude-sonnet-4-6`) |
| `GDRIVESCOPE_OPENAI_MODEL` | OpenAI LLM model override (default `gpt-5.4-nano`) |
| `GDRIVESCOPE_AZURE_OPENAI_MODEL` | Azure OpenAI LLM model override (default `gpt-5.4-nano`) |
| `GDRIVESCOPE_OPENAI_EMBEDDING_MODEL` | OpenAI embedding model override (default `text-embedding-3-small`) |
| `GDRIVESCOPE_OPENAI_EMBEDDING_DIMENSIONS` | OpenAI embedding vector size (default 1536; 3072 for `-large`) |
| `GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_MODEL` | Azure OpenAI embedding model override (default `text-embedding-3-small`) |
| `GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_DIMENSIONS` | Azure OpenAI embedding vector size (default 1536) |
| `GDRIVESCOPE_VOYAGE_EMBEDDING_MODEL` | Voyage embedding model override (default `voyage-3-lite`) |
| `GDRIVESCOPE_VOYAGE_EMBEDDING_DIMENSIONS` | Voyage embedding vector size (default 512 for `voyage-3-lite`; 1024 for `voyage-3`) |
| `GDRIVESCOPE_OLLAMA_HOST` | Ollama base URL (default `http://localhost:11434`) |
| `GDRIVESCOPE_OLLAMA_MODEL` | Ollama chat model (default `llama3.2:3b`) |
| `GDRIVESCOPE_OLLAMA_EMBEDDING_MODEL` | Ollama embedding model (default `nomic-embed-text`) |
| `GDRIVESCOPE_OLLAMA_EMBEDDING_DIMENSIONS` | Ollama embedding vector size (must match the model; default 768) |

### Paths and limits

| Variable | Purpose |
|---|---|
| `GDRIVESCOPE_MAX_SIZE` | Default `--max-size` value (bytes) |
| `GDRIVESCOPE_MAX_PDF_PAGES` | Default `--max-pdf-pages` value |
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

**Auth errors** — Run `gdrivescope logout` then `gdrivescope login` to re-authorize. Ensure your Google OAuth client has the `drive.readonly` scope enabled in the Google Cloud console.

**`SCOPE_REQUIRED` on `index`** — Your current session was authorized with `drive.metadata.readonly`, which cannot download file content. Re-authorize with `gdrivescope login --scope drive.readonly`, or pass `--metadata-only` to `index` if you only need the folder/file metadata graph. A session authorized with `drive.readonly` already covers both paths — you should never see this error on a `drive.readonly` session.

**`appNotAuthorizedToFile` 403 during `index`** — The OAuth app cannot read a specific file's content. Two causes:

1. **You logged in with the default `drive.metadata.readonly` scope.** Re-run `gdrivescope login --scope drive.readonly`. Newer builds fail fast with `SCOPE_REQUIRED` before this can happen; older builds surface it per file.
2. **The file is genuinely blocked to third-party apps.** The file was shared from an external Google Workspace tenant whose admin restricts third-party OAuth apps, or shared via "anyone with the link" instead of to your account. No scope change can fix this — ask the owner to re-share the file directly to your account, or copy it into a Shared Drive you can access. gdrivescope records these failures with a `[permanent:…]` marker in `last_error`, and `--resume` skips them on subsequent runs so they don't keep burning API quota.

**Kreuzberg extraction failures** — Native Rust extraction via the `kreuzberg` crate, with `pdf-oxide` as the PDF backend. PDF text quality is the most likely thing to vary across documents; if a particular file fails extraction, the file is skipped with an error recorded in `last_error` and `--resume` will skip it on subsequent runs. No native libraries are required at runtime.

**Provider selection** — The LLM provider resolves in order: `--provider` flag > `GDRIVESCOPE_LLM_PROVIDER` env > `config.toml [llm].provider` > auto-infer from available API keys. Embedding provider follows the same cascade. If no provider is explicitly configured, gdrivescope scans for available API keys and selects the first match.

**Rebuild embeddings** — If you switch embedding providers (e.g. from OpenAI to Voyage), the vector dimensions change. Pass `--rebuild-embeddings` on the next full index run to drop and recreate the vector table.

## Development

```bash
cargo build                                  # Debug build at target/debug/gdrivescope
cargo build --release                        # Release build (~18 MB) at target/release/gdrivescope
cargo fmt                                    # Format with rustfmt
cargo fmt --check                            # Verify formatting
cargo clippy --all-targets -- -D warnings    # Lint with clippy
cargo test                                   # Run all tests (113 passing)
```

Cross-compile a release binary for another platform:

```bash
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl
```

## License

MIT — see [LICENSE](LICENSE).
