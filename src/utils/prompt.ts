import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import { CliError } from './errors.js';

export function isTTY(): boolean {
  return !!process.stdin.isTTY;
}

export function promptHidden(label: string): Promise<string> {
  if (!isTTY()) {
    throw new CliError(
      'No TTY detected. Use --client-id and --client-secret flags or set GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET for non-interactive use.',
      'AUTH_REQUIRED'
    );
  }

  const mutableOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: mutableOutput,
    terminal: true,
  });

  return new Promise<string>((resolve) => {
    process.stderr.write(label);
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}
