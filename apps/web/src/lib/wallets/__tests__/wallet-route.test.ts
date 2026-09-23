import { describe, it, expect, vi } from 'vitest';
import type { AuthResult } from '@/lib/auth';

vi.mock('@/lib/auth', () => ({
  isMCPAuthResult: (r: { tokenType?: string }) => r.tokenType === 'mcp',
  getAllowedDriveIds: (r: { allowedDriveIds?: string[] }) => r.allowedDriveIds ?? [],
}));

import { walletCredentialOf } from '../wallet-route';

const auth = (tokenType: string) => ({ userId: 'u-1', tokenType }) as unknown as AuthResult;

describe('walletCredentialOf ([D-OW-26])', () => {
  it('X-1 (partial) only a real session is a session; every delegated credential is refused writes as a token', () => {
    expect(walletCredentialOf(auth('session'))).toBe('session');
    for (const delegated of ['mcp', 'oauth', 'service']) {
      expect(walletCredentialOf(auth(delegated)), delegated).toBe('mcp');
    }
  });
});
