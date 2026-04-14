# gdrivescope

Bun-native TypeScript CLI for Google Drive. Traverses folders into a directed graph, extracts document content to markdown, summarizes/embeds via pluggable LLM + embedding providers, and serves semantic search over a local `bun:sqlite` database with a `sqlite-vec` virtual table.

Status: **pre-alpha scaffolding**. Only a CLI stub is wired up; the command surface described below is aspirational.

## Environment variables

| Variable | Purpose |
|----------|---------|
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

## Commands

```bash
# Setup
bun install                          # Install dependencies
task build                           # Compile TypeScript to build/
task clean                           # Remove build/ and dist/

# Quality
task lint                            # Lint with Biome
task format                          # Format with Biome (write)
task test                            # Run tests (bun test)
task check                           # Lint + typecheck + tests

# Pipelines
task ci                              # Full CI locally: clean + install + format:check + check + build

# Release
task compile                         # Build standalone binary for current platform (dist/gdrivescope)
task compile:all                     # Build binaries for all 6 platforms
```

## Architecture

```text
src/
├── index.ts                    # CLI entry: parseArgs + noun-verb dispatch
├── cli/
│   ├── commands/
│   │   ├── login.ts            # OAuth loopback + PKCE
│   │   ├── logout.ts
│   │   ├── index.ts            # "gdrivescope index" — builds graph
│   │   ├── file-list.ts
│   │   ├── file-show.ts
│   │   ├── file-search.ts
│   │   └── file-download.ts
│   └── registry.ts             # noun-verb table
├── auth/
│   ├── keychain.ts             # Bun.secrets wrapper
│   └── oauth.ts                # loopback + PKCE flow
├── drive/
│   ├── client.ts               # @googleapis/drive factory + token refresh
│   ├── traversal.ts            # BFS via files.list
│   └── download.ts             # raw bytes streamer
├── graph/
│   ├── model.ts                # Node/Edge types, graphology wrapper
│   ├── store.ts                # bun:sqlite schema + CRUD + sqlite-vec init
│   ├── hydrate.ts              # load DB → in-memory graphology instance
│   └── persist.ts              # upsert node, upsert edge, write embeddings
├── extract/
│   └── kreuzberg.ts            # @kreuzberg/node wrapper (markdown out)
├── llm/
│   ├── provider.ts             # LlmProvider + EmbeddingProvider interfaces
│   ├── anthropic.ts
│   ├── openai.ts
│   ├── voyage.ts
│   ├── ollama.ts
│   └── resolver.ts             # pick provider from config/env
├── pipeline/
│   ├── index-pipeline.ts       # traverse → extract → summarize → embed → store
│   └── concurrency.ts          # bounded parallel with backoff
├── search/
│   └── vector-search.ts        # sqlite-vec query + filters
├── models/
│   └── api-response.ts         # ApiResponse<T>
├── formatters/
│   └── output.ts               # human vs json
└── utils/
    ├── logging.ts              # stderr only
    ├── config.ts               # ~/.config/gdrivescope/config.toml
    └── errors.ts
tests/
├── unit/
├── integration/                # in-memory sqlite, fake LLM provider
└── e2e/                        # compiled binary against recorded Drive fixtures
scripts/
└── spikes/                     # dependency risk spike scripts
```

## Conventions

- **Runtime:** Bun, TypeScript strict mode, ES2022, NodeNext modules
- **Formatting:** Biome (indent 2, single quotes, semicolons, trailing commas es5)
- **CLI parsing:** `parseArgs` from `node:util`, noun-verb dispatch (no commander/citty)
- **Credentials:** Bun Secrets API via `src/auth/keychain.ts` — OS keychain, no files
- **Output:** human-readable default, `--json` flag emits `{ok, data}` / `{ok, error, code}` envelope
- **Graph:** `graphology` in memory, rehydrated from sqlite on command startup; edges implicit from `parent_id`
- **Persistence:** single `~/.config/gdrivescope/drive.db` via `bun:sqlite` + `sqlite-vec` virtual table
- **Document extraction:** `@kreuzberg/node` (NAPI) with markdown output; `@kreuzberg/wasm` as fallback if NAPI fails under `bun build --compile`
- **Release:** 6-platform GitHub Actions matrix, SHA-pinned actions

## Testing

Three tiers: `tests/unit`, `tests/integration`, `tests/e2e`. All run under `bun test` with preload `tests/helpers/setup.ts`.
