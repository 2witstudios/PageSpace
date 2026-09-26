import { describe, it, expect, vi } from 'vitest';
import type { AuthResult } from '@/lib/auth';

vi.mock('@/lib/auth', () => ({
  isMCPAuthResult: (r: { tokenType?: string }) => r.tokenType === 'mcp',
  getAllowedDriveIds: (r: { allowedDriveIds?: string[] }) => r.allowedDriveIds ?? [],
}));

import { walletCredentialOf } from '../wallet-route';

const base = { userId: 'u-1', role: 'user' as const, tokenVersion: 0, adminRoleVersion: 0 };
const session: AuthResult = { ...base, tokenType: 'session', sessionId: 's-1' };
const mcp: AuthResult = { ...base, tokenType: 'mcp', tokenId: 't-1', allowedDriveIds: [] };

describe('walletCredentialOf ([D-OW-26])', () => {
  it('X-1 (partial) only a real session is a session; every delegated credential is refused writes as a token', () => {
    expect(walletCredentialOf(session)).toBe('session');
    expect(walletCredentialOf(mcp)).toBe('mcp');
    // OAuth and service results carry more fields; only the discriminant matters to the mapping.
    for (const delegated of ['oauth', 'service'] as const) {
      expect(walletCredentialOf({ ...mcp, tokenType: delegated } as unknown as AuthResult), delegated).toBe('mcp');
    }
  });
});
