import { spyOn } from 'bun:test';
import { resetVaultCache } from '../../src/auth/keychain.js';
import { SCOPE_FULL, SCOPE_METADATA } from '../../src/auth/oauth.js';

export function stubVault(
  scope: string = `${SCOPE_METADATA} ${SCOPE_FULL}`
): () => void {
  resetVaultCache();
  const spy = spyOn(Bun.secrets, 'get').mockResolvedValue(
    JSON.stringify({
      refreshToken: 'r',
      scope,
      obtainedAt: 0,
      clientId: 'id',
      clientSecret: 'secret',
    })
  );
  return () => {
    spy.mockRestore();
    resetVaultCache();
  };
}
