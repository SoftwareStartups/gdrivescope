# CLI Layer

## Command Contract

Every file in `commands/` exports exactly four named members:

- `HELP: string` — full help text shown by `--help`
- `run(flags: XxxFlags): Promise<ApiResponse<XxxData>>` — does the work, returns typed response
- `render(data: XxxData): string` — formats success data for human output
- `XxxFlags` interface — typed flag inputs (includes `_positional?: string` when the command takes a positional arg)

Commands never call `emit()` or write to stdout directly. The `wrap()` function in `registry.ts` wires `run` and `render` into the `Command` interface that `index.ts` dispatches to.

## Dispatch

`registry` is a two-level map: `noun → verb → Command`.

- Top-level commands (login, logout, index) use the `_` sentinel as their verb key
- `_positional` is injected into flags by `index.ts`: `positionals[1]` for `_`-verb commands, `positionals[2]` for noun-verb commands

## Adding a New Command

1. Create `commands/<noun>-<verb>.ts` exporting `HELP`, `run`, `render`, and flag/data types
2. Register in `registry.ts` under the appropriate noun group via `wrap()`
3. Add `parseArgs` entries in `src/index.ts` for any new flags
4. Include `--json` in the HELP text Options section

## Patterns

- Wrap all work in try/catch returning `toResponse(err)` on failure
- Open and close stores inside `run()`, not in the caller or `render()`
- Flag parsing and validation happens inside `run()`
- Use `CliError` with a typed error code for all user-facing errors
