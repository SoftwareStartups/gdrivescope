import { describe, expect, test } from 'bun:test';
import { isKreuzbergNoise } from '../../src/extract/wasm-console-filter.js';

describe('isKreuzbergNoise', () => {
  test.each([
    'Size entry of trailer dictionary is 53, correct value is 48.',
    'Size entry of trailer dictionary is 21, correct value is 20',
  ])('matches lopdf trailer warning: %s', (msg) => {
    expect(isKreuzbergNoise('warn', msg)).toBe(true);
  });

  test('does not suppress unrelated warn messages', () => {
    expect(isKreuzbergNoise('warn', 'Something else went wrong')).toBe(false);
    expect(isKreuzbergNoise('warn', '')).toBe(false);
  });

  test('matches panic-hook RuntimeError stack', () => {
    const stack =
      "RuntimeError: Unreachable code should not be executed (evaluating 'wasm.wasm_bindgen__convert__closures_____invoke__ha785dc36a6aa08a3(arg0, arg1, arg2)')\n      at wasm_bindgen__convert__closures_____invoke__ha785dc36a6aa08a3 (/$bunfs/root/gdrivescope:41687:81)";
    expect(isKreuzbergNoise('error', stack)).toBe(true);
  });

  test('does not suppress unrelated error messages', () => {
    expect(isKreuzbergNoise('error', 'RuntimeError: out of memory')).toBe(
      false
    );
    expect(isKreuzbergNoise('error', 'regular error')).toBe(false);
  });

  test('trailer pattern only matches warn level, not error', () => {
    const msg = 'Size entry of trailer dictionary is 53, correct value is 48.';
    expect(isKreuzbergNoise('error', msg)).toBe(false);
  });

  test('matches bare panic message from uncaughtException', () => {
    const msg =
      "Unreachable code should not be executed (evaluating 'wasm.wasm_bindgen__convert__closures_____invoke__ha785dc36a6aa08a3(arg0, arg1, arg2)')";
    expect(isKreuzbergNoise('uncaught', msg)).toBe(true);
  });

  test('uncaught level does not match other messages', () => {
    expect(isKreuzbergNoise('uncaught', 'out of memory')).toBe(false);
    expect(
      isKreuzbergNoise('uncaught', 'Unreachable code in unrelated module')
    ).toBe(false);
  });
});
