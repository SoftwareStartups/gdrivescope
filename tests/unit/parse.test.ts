import { describe, expect, test } from 'bun:test';
import {
  parseOptionalPositiveInt,
  parsePositiveInt,
} from '../../src/utils/parse.js';
import { CliError } from '../../src/utils/errors.js';

describe('parsePositiveInt', () => {
  test('returns fallback when value is undefined', () => {
    expect(parsePositiveInt('limit', undefined, 42)).toBe(42);
  });

  test('parses valid integer string', () => {
    expect(parsePositiveInt('limit', '10', 1)).toBe(10);
  });

  test('truncates fractional values', () => {
    expect(parsePositiveInt('limit', '3.9', 1)).toBe(3);
  });

  test('throws on non-numeric input', () => {
    expect(() => parsePositiveInt('limit', 'abc', 1)).toThrow(CliError);
  });

  test('throws on zero', () => {
    expect(() => parsePositiveInt('limit', '0', 1)).toThrow(CliError);
  });

  test('throws on negative', () => {
    expect(() => parsePositiveInt('limit', '-5', 1)).toThrow(CliError);
  });

  test('error message includes label', () => {
    try {
      parsePositiveInt('max-size', 'bad', 1);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain('--max-size');
    }
  });
});

describe('parseOptionalPositiveInt', () => {
  test('returns undefined when value is undefined', () => {
    expect(parseOptionalPositiveInt('concurrency', undefined)).toBeUndefined();
  });

  test('parses valid integer string', () => {
    expect(parseOptionalPositiveInt('concurrency', '8')).toBe(8);
  });

  test('throws on invalid input', () => {
    expect(() => parseOptionalPositiveInt('concurrency', 'x')).toThrow(
      CliError
    );
  });
});
