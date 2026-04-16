export interface EnvGuard {
  setup(): void;
  teardown(): void;
}

export function useEnvGuard(keys: readonly string[]): EnvGuard {
  const saved: Record<string, string | undefined> = {};
  return {
    setup() {
      for (const k of keys) {
        saved[k] = Bun.env[k];
        delete Bun.env[k];
      }
    },
    teardown() {
      for (const k of keys) {
        if (saved[k] === undefined) delete Bun.env[k];
        else Bun.env[k] = saved[k];
      }
    },
  };
}
