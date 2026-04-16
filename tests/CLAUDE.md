# Testing

## Three Tiers

- `tests/unit/` — Pure logic, no I/O. Uses in-memory sqlite via `seedStore()` for graph/store tests.
- `tests/integration/` — Full command and pipeline flows with fake providers and in-memory stores.
- `tests/e2e/` — (Planned) Compiled binary against recorded Drive fixtures.

All tiers run under `bun test` with preload `tests/helpers/setup.ts` (resets `process.exitCode` after each test).

## Helpers

| Helper | Purpose |
|--------|---------|
| `seedStore(nodes)` | Opens `:memory:` store, upserts nodes, returns `Store` |
| `nodeInput(overrides)` | Builds a `DriveNodeInput` with folder defaults — only `id` required |
| `FakeLlmProvider` | Implements `LlmProvider`, records `.calls[]`, returns deterministic summaries |
| `FakeEmbeddingProvider` | Implements `EmbeddingProvider`, bag-of-characters projection (deterministic, L2-normalised) |
| `makeFakeDrive(tree)` | Returns fake `drive_v3.Drive` + call counters from a `FakeTree` fixture |

## Module Mocking

Use `mock.module()` (Bun built-in) for module-level overrides. Import the mocked module after the `mock.module()` call, not before.

## Patterns

- Test files mirror source structure: `tests/unit/store.test.ts` tests `src/graph/store.ts`
- Use `describe` blocks by function/feature, `test` or `it` for cases
- Close stores in `afterEach` or `finally`
- Prefer `seedStore` + `nodeInput` over building raw objects
- Capture output by spying on `process.stdout.write` / `process.stderr.write`
