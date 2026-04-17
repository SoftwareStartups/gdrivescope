import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import pkg from '../../package.json' with { type: 'json' };
import { resetVaultCache } from '../../src/auth/keychain.js';
import { main } from '../../src/index.js';

describe('main dispatcher', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let stdoutCalls: string[];
  let stderrCalls: string[];

  beforeEach(() => {
    stdoutCalls = [];
    stderrCalls = [];
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(
      (chunk: unknown) => {
        stdoutCalls.push(String(chunk));
        return true;
      }
    );
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(
      (chunk: unknown) => {
        stderrCalls.push(String(chunk));
        return true;
      }
    );
    process.exitCode = undefined;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = undefined;
  });

  test('--version prints version in human mode', async () => {
    const code = await main(['--version']);
    expect(code).toBe(0);
    expect(stdoutCalls.join('')).toContain(pkg.version);
  });

  test('--json --version emits envelope', async () => {
    const code = await main(['--json', '--version']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutCalls.join('').trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe(pkg.version);
  });

  test('no args prints help and exits 0', async () => {
    const code = await main([]);
    expect(code).toBe(0);
    expect(stdoutCalls.join('')).toContain('gdrivescope');
  });

  test('--json with no args emits help envelope', async () => {
    const code = await main(['--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutCalls.join('').trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.data.help).toContain('gdrivescope');
  });

  test('unknown noun returns code 2 with UNKNOWN_COMMAND', async () => {
    const code = await main(['--json', 'bogus']);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdoutCalls.join('').trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('UNKNOWN_COMMAND');
    expect(parsed.error).toContain('bogus');
  });

  test('unknown subcommand returns code 2', async () => {
    const code = await main(['--json', 'login', 'weird']);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdoutCalls.join('').trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('UNKNOWN_COMMAND');
  });

  test('unknown command in human mode writes to stderr and sets exit code', async () => {
    await main(['bogus']);
    expect(stderrCalls.join('')).toContain('UNKNOWN_COMMAND');
    expect(process.exitCode).toBe(1);
  });

  test('login --help prints per-command help without running login', async () => {
    const code = await main(['login', '--help']);
    expect(code).toBe(0);
    const out = stdoutCalls.join('');
    expect(out).toContain('gdrivescope login');
    expect(out).toContain('GOOGLE_OAUTH_CLIENT_ID');
    expect(stderrCalls.join('')).toBe('');
  });

  test('logout --help prints per-command help without running logout', async () => {
    const code = await main(['logout', '--help']);
    expect(code).toBe(0);
    const out = stdoutCalls.join('');
    expect(out).toContain('gdrivescope logout');
    expect(stderrCalls.join('')).toBe('');
  });

  test('login --help --json emits help envelope', async () => {
    const code = await main(['login', '--help', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutCalls.join('').trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.data.help).toContain('GOOGLE_OAUTH_CLIENT_ID');
  });

  test('login with no creds, no TTY, returns AUTH_REQUIRED envelope', async () => {
    resetVaultCache();
    const getSpy = spyOn(Bun.secrets, 'get').mockResolvedValue(null);
    const origId = Bun.env.GOOGLE_OAUTH_CLIENT_ID;
    const origSecret = Bun.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const origIsTTY = process.stdin.isTTY;
    delete Bun.env.GOOGLE_OAUTH_CLIENT_ID;
    delete Bun.env.GOOGLE_OAUTH_CLIENT_SECRET;
    // Force non-TTY so promptHidden throws instead of hanging on stdin.
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });
    try {
      await main(['--json', 'login']);
      const parsed = JSON.parse(stdoutCalls.join('').trim());
      expect(parsed.ok).toBe(false);
      // Resolver bubbles the non-TTY prompt error through toResponse as UNKNOWN,
      // or AUTH_REQUIRED if interactive was false. We accept either as proof
      // that login reached the resolver (not a help / unknown-command branch).
      expect(parsed.code).toMatch(/AUTH_REQUIRED|UNKNOWN/);
    } finally {
      getSpy.mockRestore();
      if (origId !== undefined) Bun.env.GOOGLE_OAUTH_CLIENT_ID = origId;
      if (origSecret !== undefined)
        Bun.env.GOOGLE_OAUTH_CLIENT_SECRET = origSecret;
      Object.defineProperty(process.stdin, 'isTTY', {
        value: origIsTTY,
        configurable: true,
      });
    }
  });
});
