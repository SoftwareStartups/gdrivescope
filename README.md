# gdrivescope

A Bun-native TypeScript CLI for Google Drive: traverse folders into a local graph, extract and summarize documents, and run semantic search — all from your terminal.

> **Status: pre-alpha scaffolding.** The repository currently only ships a CLI stub. Commands below describe the intended surface and are not yet implemented.

## What is it?

`gdrivescope` is an AI-first command-line tool that communicates with the Google Drive API. Its primary consumer is AI agents via `--json`; humans are the secondary audience via pretty terminal output. It produces a standalone single binary with no runtime dependencies on Python, Docker, or system libraries.

Planned capabilities:

- OAuth login via the browser (loopback 127.0.0.1 + PKCE)
- Traverse a Drive folder into a directed graph
- Extract document content to markdown (PDF, Office, and dozens of other formats)
- Summarize and classify with a pluggable LLM provider (Anthropic, OpenAI, or local Ollama)
- Persist the graph and vector embeddings in a single SQLite database
- Run semantic search with filters over the indexed graph
- Download raw Drive files to disk

## Installation

### From GitHub Releases (once published)

Pre-compiled binaries for six platforms (linux/darwin/windows × x64/arm64) will be available at [GitHub Releases](https://github.com/SoftwareStartups/gdrivescope/releases) once a `v*` tag ships.

### From source

Prerequisites: [Bun](https://bun.sh) and [Task](https://taskfile.dev)

```bash
git clone https://github.com/SoftwareStartups/gdrivescope.git
cd gdrivescope
bun install
task compile
./dist/gdrivescope --help
```

## Commands (planned)

| Command | Purpose |
|---|---|
| `gdrivescope login` | OAuth loopback flow, store refresh token in OS keychain |
| `gdrivescope logout` | Clear stored credentials |
| `gdrivescope index [--scope FOLDER_ID] [--metadata-only]` | Traverse + extract + summarize + embed |
| `gdrivescope file list [FOLDER_ID] [-r]` | Tree listing from the local graph |
| `gdrivescope file show <ID>` | Node details (path, metadata, summary, topics) |
| `gdrivescope file search <QUERY>` | Semantic + filter search via `sqlite-vec` |
| `gdrivescope file download <ID> [-o PATH]` | Raw bytes to disk |
| `gdrivescope ollama setup` | Configure a local Ollama LLM/embedding provider |

## Global options

| Flag | Description |
|---|---|
| `--json` | Emit structured `{ok, data}` / `{ok, error, code}` responses |
| `--version`, `-v` | Print version |
| `--help`, `-h` | Show help |

## Environment variables

| Variable | Purpose |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Drive API credentials |
| `ANTHROPIC_API_KEY` | Anthropic LLM provider |
| `OPENAI_API_KEY` | OpenAI LLM / embedding provider |
| `VOYAGE_API_KEY` | Voyage embedding provider |
| `GDRIVESCOPE_LLM_PROVIDER` | `anthropic` \| `openai` \| `ollama` |
| `GDRIVESCOPE_EMBEDDING_PROVIDER` | `openai` \| `voyage` \| `ollama` |
| `GDRIVESCOPE_OLLAMA_HOST` | Ollama base URL (default `http://localhost:11434`) |
| `GDRIVESCOPE_OLLAMA_MODEL` | Ollama chat model |
| `GDRIVESCOPE_OLLAMA_EMBEDDING_MODEL` | Ollama embedding model |
| `GDRIVESCOPE_OLLAMA_EMBEDDING_DIMENSIONS` | Ollama embedding vector size |

## Development

```bash
bun install        # Install dependencies
task build         # Compile TypeScript to build/
task lint          # Lint with Biome
task format        # Format with Biome
task test          # Run tests
task check         # Lint + typecheck + tests
task ci            # Full CI pipeline locally
task compile       # Build standalone binary to dist/
task compile:all   # Build all 6 platform binaries
```

## License

MIT — see [LICENSE](LICENSE).
