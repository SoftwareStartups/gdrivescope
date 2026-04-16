import { CliError } from './errors.js';

export function parsePositiveInt(
  label: string,
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new CliError(`invalid --${label} value: ${value}`, 'USAGE');
  }
  return Math.trunc(n);
}

export function parseOptionalPositiveInt(
  label: string,
  value: string | undefined
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new CliError(`invalid --${label} value: ${value}`, 'USAGE');
  }
  return Math.trunc(n);
}
