#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { registry } from './cli/registry.js';
import { emit, setJsonMode } from './formatters/output.js';
import { fail, success } from './models/api-response.js';
import { toResponse } from './utils/errors.js';

const HELP = `gdrivescope — Google Drive indexing, search, and download CLI

Usage:
  gdrivescope <command> [options]

Commands:
  login                Authorize with Google Drive (OAuth loopback + PKCE)
  logout               Clear stored credentials
  index                Build or refresh the persistent Drive graph
  config show          Print the workspace config
  config list-roots    List configured root folders
  config add-root      Persist a Drive folder as a root
  config remove-root   Remove a configured root
  ollama setup         Configure local Ollama for gdrivescope
  file list            List files under a folder from the indexed graph
  file show            Show a single node from the indexed graph
  file search          Search the indexed graph by file name
  file download        Download a file from Drive

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
      scope: { type: 'string' },
      root: { type: 'string' },
      'add-root': { type: 'boolean' },
      label: { type: 'string' },
      'metadata-only': { type: 'boolean' },
      concurrency: { type: 'string' },
      'concurrency-drive': { type: 'string' },
      'concurrency-llm': { type: 'string' },
      resume: { type: 'boolean' },
      prune: { type: 'boolean' },
      provider: { type: 'string' },
      'embedding-provider': { type: 'string' },
      'rebuild-embeddings': { type: 'boolean' },
      host: { type: 'string' },
      'llm-model': { type: 'string' },
      'embedding-model': { type: 'string' },
      'skip-pull': { type: 'boolean' },
      'max-size': { type: 'string' },
      'max-pdf-pages': { type: 'string' },
      recursive: { type: 'boolean', short: 'r' },
      limit: { type: 'string' },
      threshold: { type: 'string' },
      classification: { type: 'string' },
      format: { type: 'string' },
      output: { type: 'string', short: 'o' },
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

  const commandFlags: Record<string, unknown> = { ...values };
  // A nested command (e.g. `file list <id>`) resolves its positional at
  // index 2 (after noun + verb); top-level commands that use the `_` sentinel
  // verb take their positional at index 1.
  commandFlags._positional = verb === '_' ? positionals[1] : positionals[2];

  try {
    await command.execute(commandFlags, {
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
