# gdrivescope

Bun-native TypeScript CLI for Google Drive. Traverses folders into a directed graph, extracts document content to markdown, summarizes/embeds via pluggable LLM + embedding providers, and serves semantic search over a local `bun:sqlite` database with a `sqlite-vec` virtual table.

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
| `GDRIVESCOPE_MAX_SIZE` | Default `--max-size` value (bytes) |
| `GDRIVESCOPE_MAX_PDF_PAGES` | Default `--max-pdf-pages` value |

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
task test:unit                       # Unit tests only
task test:integration                # Integration tests only
task check                           # Lint + typecheck + tests

# Pipelines
task ci                              # Full CI locally: clean + install + format:check + check + build

# Release
task compile                         # Build standalone binary for current platform (dist/gdrivescope)
task compile:all                     # Build binaries for all 6 platforms
```

## Architecture

```
src/
  index.ts       CLI entry: parseArgs + noun-verb dispatch
  auth/          OAuth 2.0 + PKCE loopback, keychain vault, credential resolution
  cli/           Noun-verb command registry + 11 command implementations
  config/        TOML workspace config (~/.config/gdrivescope/config.toml)
  drive/         Google Drive API client, BFS traversal, download/exports, ancestry
  extract/       Kreuzberg markdown extraction, MIME filtering, PDF slicing
  formatters/    Human vs JSON output emitter
  graph/         bun:sqlite store, graphology model, hydration, path helpers
  llm/           LLM + embedding provider interfaces, implementations, resolvers
  models/        ApiResponse<T> envelope
  pipeline/      Index orchestration, bounded concurrency, pruning
  search/        sqlite-vec kNN query + post-filtering
  utils/         Config paths, typed errors, logging, interactive prompts
tests/
  unit/          Pure logic tests
  integration/   Cross-module tests with fake providers
  helpers/       Shared test factories and fakes
```

## Conventions

- **Runtime:** Bun, TypeScript strict mode, ES2022, NodeNext modules
- **Formatting:** Biome (indent 2, single quotes, semicolons, trailing commas es5)
- **CLI parsing:** `parseArgs` from `node:util`, noun-verb dispatch (no commander/citty)
- **Credentials:** Bun Secrets API via `src/auth/keychain.ts` — OS keychain, no files
- **Output:** human-readable default, `--json` flag emits `{ok, data}` / `{ok, error, code}` envelope
- **Graph:** `graphology` in memory, rehydrated from sqlite on command startup; edges implicit from `parent_id`
- **Persistence:** single `~/.config/gdrivescope/drive.db` via `bun:sqlite` + `sqlite-vec` virtual table
- **Document extraction:** `@kreuzberg/wasm` for markdown extraction; system SQLite with extension support required for `sqlite-vec`
- **Release:** 6-platform GitHub Actions matrix, SHA-pinned actions

## Testing

Three tiers: `tests/unit`, `tests/integration`, `tests/e2e`. See `tests/CLAUDE.md` for helpers and mocking patterns.

## See also

- `src/cli/CLAUDE.md` — command contract, dispatch, adding new commands
- `src/llm/CLAUDE.md` — provider interfaces, resolver cascade, adding providers
- `src/graph/CLAUDE.md` — SQLite setup, schema, vec0 quirks, graphology hydration
- `tests/CLAUDE.md` — test tiers, helpers, mocking patterns
- `.github/CLAUDE.md` — CI workflow, release workflow, SHA pinning
- `.claude/rules/typescript-style.md` — TypeScript + Biome coding rules
