import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

import { conversationSpendKey } from '../useConversationSpend';
import { driveWalletKey } from '../useDriveWallet';

describe('the spend source request keys', () => {
  it('SPEND-3 (partial) a drive or page conversation is read by its id alone; the server resolves its drive', () => {
    expect(conversationSpendKey('c 1', 'd1', false)).toBe('/api/wallets/conversations/c%201');
  });

  it('SPEND-2 (partial) a global conversation previews in the drive its turns name (?driveId=)', () => {
    expect(conversationSpendKey('c1', 'd1', true)).toBe('/api/wallets/conversations/c1?driveId=d1');
    expect(conversationSpendKey('c1', null, true)).toBe('/api/wallets/conversations/c1');
  });

  it('UI-9 (partial) no conversation or no drive means no request', () => {
    expect(conversationSpendKey(null, 'd1', false)).toBeNull();
    expect(driveWalletKey(null)).toBeNull();
    expect(driveWalletKey('d1')).toBe('/api/drives/d1/wallet');
  });
});
