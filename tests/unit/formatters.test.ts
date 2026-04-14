import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { fail, success } from '../../src/models/api-response.js';
import { emit, setJsonMode } from '../../src/formatters/output.js';

describe('emit', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    setJsonMode(false);
    process.exitCode = undefined;
  });

  test('writes human text to stdout by default on success', () => {
    setJsonMode(false);
    const before = process.exitCode;
    emit(success({ scope: 'x' }), (d) => `Signed in: ${d.scope}`);
    expect(stdoutSpy).toHaveBeenCalledWith('Signed in: x\n');
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(before);
  });

  test('writes JSON envelope to stdout on success when jsonMode', () => {
    setJsonMode(true);
    emit(success({ n: 1 }), () => 'unused');
    expect(stdoutSpy).toHaveBeenCalledWith(
      `${JSON.stringify({ ok: true, data: { n: 1 } })}\n`
    );
  });

  test('writes error text to stderr by default on failure', () => {
    setJsonMode(false);
    emit(fail('nope', 'AUTH_FAILED'), () => 'unused');
    expect(stderrSpy).toHaveBeenCalledWith('error: nope (AUTH_FAILED)\n');
    expect(process.exitCode).toBe(1);
  });

  test('writes JSON envelope to stdout on failure when jsonMode', () => {
    setJsonMode(true);
    emit(fail('nope', 'AUTH_FAILED'), () => 'unused');
    expect(stdoutSpy).toHaveBeenCalledWith(
      `${JSON.stringify({ ok: false, error: 'nope', code: 'AUTH_FAILED' })}\n`
    );
    expect(process.exitCode).toBe(1);
  });
});
