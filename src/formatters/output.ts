import type { ApiResponse } from '../models/api-response.js';

let jsonMode = false;

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

export function emit<T>(
  response: ApiResponse<T>,
  human: (data: T) => string
): void {
  if (!response.ok) {
    process.exitCode = 1;
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } else {
      process.stderr.write(`error: ${response.error} (${response.code})\n`);
    }
    return;
  }
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } else {
    process.stdout.write(`${human(response.data)}\n`);
  }
}
