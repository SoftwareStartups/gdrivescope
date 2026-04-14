let quiet = false;

export function setQuiet(on: boolean): void {
  quiet = on;
}

function write(prefix: string, message: string): void {
  if (quiet) return;
  process.stderr.write(`${prefix}${message}\n`);
}

export function info(message: string): void {
  write('', message);
}

export function warn(message: string): void {
  write('warn: ', message);
}

export function error(message: string): void {
  if (quiet) return;
  process.stderr.write(`error: ${message}\n`);
}
