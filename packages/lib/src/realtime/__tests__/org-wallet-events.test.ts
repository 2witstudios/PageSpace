import { describe, it, expect } from 'vitest';
import { orgChangedMessages, walletChangedMessage, ORG_CHANGED_EVENT, WALLET_CHANGED_EVENT } from '../org-wallet-events';

describe('org and wallet realtime events: the contract the UI listens on', () => {
  it('X-4 (partial) a drive wallet change is one wallet:changed on the drive\'s room, naming what changed and carrying no amount', () => {
    const msg = walletChangedMessage({ driveId: 'd-product', walletId: 'w-product', change: 'balance' });
    expect(msg).toEqual({ channelId: 'drive:d-product', event: WALLET_CHANGED_EVENT, payload: { driveId: 'd-product', walletId: 'w-product', change: 'balance' } });
    expect(WALLET_CHANGED_EVENT).toBe('wallet:changed');
    expect(JSON.stringify(msg)).not.toMatch(/Cents|Credits/);
  });

  it('X-4 (partial) an org change reaches every accepted member on their own channel, once each, naming what changed', () => {
    const msgs = orgChangedMessages({ orgId: 'org-1', change: 'status' }, ['u-b', 'u-a', 'u-a']);
    expect(msgs).toEqual([
      { channelId: 'notifications:u-a', event: ORG_CHANGED_EVENT, payload: { orgId: 'org-1', change: 'status' } },
      { channelId: 'notifications:u-b', event: ORG_CHANGED_EVENT, payload: { orgId: 'org-1', change: 'status' } },
    ]);
    expect(ORG_CHANGED_EVENT).toBe('org:changed');
  });
});
