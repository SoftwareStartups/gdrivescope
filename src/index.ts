#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };

const HELP = `gdrivescope — Google Drive indexing, search, and download CLI

Usage:
  gdrivescope <command> [options]

Commands:
  (none yet — scaffolding stage)

Global options:
  --help, -h       Show this message
  --version, -v    Print version
  --json           Emit structured JSON responses
`;

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string };

function emit<T>(response: ApiResponse<T>, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return;
  }
  if (response.ok) {
    process.stdout.write(`${String(response.data)}\n`);
  } else {
    process.stderr.write(`error: ${response.error} (${response.code})\n`);
  }
}

function main(): number {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false,
  });

  const asJson = values.json === true;

  if (values.version) {
    emit({ ok: true, data: pkg.version }, asJson);
    return 0;
  }

  if (values.help || Bun.argv.length <= 2) {
    if (asJson) {
      emit({ ok: true, data: { help: HELP.trim() } }, asJson);
    } else {
      process.stdout.write(HELP);
    }
    return 0;
  }

  emit(
    {
      ok: false,
      error: 'no commands implemented yet — this is a scaffolding stub',
      code: 'NOT_IMPLEMENTED',
    },
    asJson
  );
  return 1;
}

process.exit(main());
