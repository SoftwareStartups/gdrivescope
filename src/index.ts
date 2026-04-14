#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { fail, success } from './models/api-response.js';
import { emit, setJsonMode } from './formatters/output.js';
import { registry } from './cli/registry.js';
import { toResponse } from './utils/errors.js';

const HELP = `gdrivescope — Google Drive indexing, search, and download CLI

Usage:
  gdrivescope <command> [options]

Commands:
  login            Authorize with Google Drive (OAuth loopback + PKCE)
  logout           Clear stored credentials

Global options:
  --help, -h       Show this message
  --version, -v    Print version
  --json           Emit structured JSON responses
`;

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      'client-id': { type: 'string' },
      'client-secret': { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });

  const asJson = values.json === true;
  setJsonMode(asJson);

  if (values.version) {
    emit(success(pkg.version), (v) => v);
    return exitCodeOrZero();
  }

  if (positionals.length === 0) {
    printHelp(asJson, HELP);
    return 0;
  }

  const noun = positionals[0] as string;
  const verb = positionals[1] ?? '_';
  const group = registry[noun];
  if (!group) {
    emit(fail(`Unknown command: ${noun}`, 'UNKNOWN_COMMAND'), (d) => String(d));
    return 2;
  }
  const command = group[verb];
  if (!command) {
    emit(fail(`Unknown subcommand: ${noun} ${verb}`, 'UNKNOWN_COMMAND'), (d) =>
      String(d)
    );
    return 2;
  }

  const wantsHelp = values.help === true;
  if (wantsHelp) {
    printHelp(asJson, command.help);
    return 0;
  }

  try {
    await command.execute(values, {
      json: asJson,
      help: wantsHelp,
    });
  } catch (err) {
    emit(toResponse(err), (d) => String(d));
  }

  return exitCodeOrZero();
}

function printHelp(asJson: boolean, text: string): void {
  if (asJson) {
    emit(success({ help: text.trim() }), (d) => d.help);
  } else {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }
}

function exitCodeOrZero(): number {
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
