import { afterEach } from 'bun:test';

// Some tests deliberately set process.exitCode via emit(fail(...)). If we don't
// reset it, a clean test run ends with bun test itself exiting non-zero.
afterEach(() => {
  process.exitCode = 0;
});
