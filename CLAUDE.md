# gdrivescope

Native Rust CLI for Google Drive. Traverses folders into a directed graph, extracts document content to markdown, summarizes/embeds via pluggable LLM + embedding providers, and serves semantic search over a local SQLite database with a `sqlite-vec` virtual table. Single static binary, no runtime libsqlite3 / libpdfium / OpenSSL dependency.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth client id (required for `login`) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret (required for `login`) |
| `ANTHROPIC_API_KEY` | Anthropic LLM provider |
| `OPENAI_API_KEY` | OpenAI LLM / embedding provider |
| `VOYAGE_API_KEY` | Voyage embedding provider |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI resource endpoint |
| `AZURE_OPENAI_API_VERSION` | Azure OpenAI API version (default `2024-06-01`) |
| `AZURE_OPENAI_LLM_DEPLOYMENT` | Azure deployment name for LLM |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | Azure deployment name for embeddings |
| `GDRIVESCOPE_LLM_PROVIDER` | `anthropic` \| `openai` \| `azure-openai` \| `ollama` |
| `GDRIVESCOPE_EMBEDDING_PROVIDER` | `openai` \| `azure-openai` \| `voyage` \| `ollama` |
| `GDRIVESCOPE_ANTHROPIC_MODEL` | Anthropic LLM model override |
| `GDRIVESCOPE_OPENAI_MODEL` | OpenAI LLM model override |
| `GDRIVESCOPE_AZURE_OPENAI_MODEL` | Azure OpenAI LLM model override |
| `GDRIVESCOPE_OPENAI_EMBEDDING_MODEL` | OpenAI embedding model override |
| `GDRIVESCOPE_OPENAI_EMBEDDING_DIMENSIONS` | OpenAI embedding vector size (default 1536 for `text-embedding-3-small`; 3072 for `-large`) |
| `GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_MODEL` | Azure OpenAI embedding model override |
| `GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_DIMENSIONS` | Azure OpenAI embedding vector size |
| `GDRIVESCOPE_VOYAGE_EMBEDDING_MODEL` | Voyage embedding model override |
| `GDRIVESCOPE_VOYAGE_EMBEDDING_DIMENSIONS` | Voyage embedding vector size (default 512 for `voyage-3-lite`; 1024 for `voyage-3`) |
| `GDRIVESCOPE_OLLAMA_HOST` | Ollama base URL (default `http://localhost:11434`) |
| `GDRIVESCOPE_OLLAMA_MODEL` | Ollama chat model |
| `GDRIVESCOPE_OLLAMA_EMBEDDING_MODEL` | Ollama embedding model |
| `GDRIVESCOPE_OLLAMA_EMBEDDING_DIMENSIONS` | Ollama embedding vector size |
| `GDRIVESCOPE_MAX_SIZE` | Default `--max-size` value (bytes) |
| `GDRIVESCOPE_MAX_PDF_PAGES` | Default `--max-pdf-pages` value |

## Commands

```bash
# Build
cargo build                                  # Debug build at target/debug/gdrivescope
cargo build --release                        # Optimized release build at target/release/gdrivescope (~18 MB)

# Quality
cargo fmt                                    # Format with rustfmt
cargo fmt --check                            # Verify formatting (CI gate)
cargo clippy --all-targets -- -D warnings    # Lint with clippy (CI gate)
cargo test                                   # Run all tests (113 unit tests)

# Local CI equivalent
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test && cargo build --release
```

The `release.yml` workflow builds 6-platform binaries on `v*` tag pushes:
linux-x64 (musl, fully static), linux-arm64, darwin-x64, darwin-arm64,
windows-x64, windows-arm64. The `macos-*` runners' linker emits an ad-hoc
signature automatically (verified by the workflow); no manual `codesign`
step is needed for release artifacts.

## Architecture

```
src/
  main.rs            CLI entry point (#[tokio::main] -> cli::run())
  lib.rs             Crate root; module re-exports for tests
  error.rs           CliError + ErrorCode variants
  models.rs          ApiResponse<T> JSON envelope
  formatters.rs      Human vs JSON output emitter (set_json_mode + emit)
  utils.rs           config_dir, db_path helpers
  config.rs          TOML workspace config (~/.config/gdrivescope/config.toml)
  extract.rs         Kreuzberg markdown extraction (pdf-oxide backend)
  search.rs          sqlite-vec kNN query + post-filtering
  auth/              OAuth 2.0 + PKCE loopback, keyring vault, credential resolution
  drive/             Google Drive API client, BFS traversal, download/exports, ancestry
  graph/             rusqlite + sqlite-vec store, graph model, hydration, path helpers
  llm/               LLM + embedding provider traits, 8 provider impls, resolver
  pipeline/          Index orchestration, bounded concurrency, pruning
  cli/               clap-derive Cli + per-command implementations (login, logout,
                     index, list, show, search, download, config, ollama)
tests/
  (reserved for future integration tests against recorded Drive fixtures;
   unit tests live inline in `#[cfg(test)] mod tests` blocks per module)
```

## Conventions

- **Runtime:** Rust 2021 edition, MSRV 1.85 (pinned in `rust-toolchain.toml`)
- **Async:** tokio multi-thread runtime; bounded concurrency via `Arc<tokio::sync::Semaphore>`
- **CLI parsing:** `clap` with the `derive` feature; noun-verb dispatch via `Cmd` enum
- **Credentials:** `keyring` crate (apple-native, windows-native, sync-secret-service); vault JSON layout is byte-equivalent to the previous TS implementation so login state is portable across binaries
- **Output:** human-readable default; `--json` flag emits `{ok, data}` / `{ok, error, code}` envelope
- **Persistence:** single `~/.config/gdrivescope/drive.db` via `rusqlite` (bundled SQLite) + `sqlite-vec` virtual table — no system libsqlite3 dependency
- **Document extraction:** `kreuzberg` crate with the `pdf-oxide` feature — pure-Rust PDF extraction, no libpdfium runtime dependency
- **HTTP:** `reqwest` with `rustls-tls` (no OpenSSL); 3 Drive REST endpoints called directly
- **LLM providers:** hand-rolled per-provider modules — Anthropic (tool_use + cache_control), OpenAI (json_schema strict), Azure OpenAI, Ollama (`format` param + retry-on-malformed)
- **Embedding providers:** OpenAI, Azure OpenAI, Voyage (output_dimension), Ollama
- **Errors:** `thiserror`-based `CliError` with stable `ErrorCode` variants surfaced through the JSON envelope
- **Release:** 6-platform GitHub Actions matrix on `v*` tags, SHA-pinned actions

## Testing

113 unit tests live inline as `#[cfg(test)] mod tests { ... }` blocks within each module. Provider integration uses fakes — no live API calls during tests. Run all tests with `cargo test`. The repo-root `tests/` directory is reserved for future cargo integration tests (e.g. compiled binary against recorded Drive fixtures).

## See also

- `.github/CLAUDE.md` — CI workflow, release workflow, SHA pinning
