import { describe, it, expect, vi } from 'vitest';
import { emitSpendPreferencesChanged, emitWalletChanged, orgChangeRecipients, orgChangedMessages, spendPreferencesMessage, SPEND_PREFERENCES_EVENT, walletChangedMessage, ORG_CHANGED_EVENT, WALLET_CHANGED_EVENT } from '../org-wallet-events';

describe('org and wallet realtime events: the contract the UI listens on', () => {
  it('X-4 (partial) a drive wallet change is one wallet:changed on the drive wallet room, naming what changed and carrying no amount', () => {
    const msg = walletChangedMessage({ driveId: 'd-product', walletId: 'w-product', change: 'balance' });
    expect(msg).toEqual({ channelId: 'drive:d-product:wallet', event: WALLET_CHANGED_EVENT, payload: { driveId: 'd-product', walletId: 'w-product', change: 'balance' } });
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

  it('X-4 (partial) an invitations change reaches only the Owner and Admins, the people who can see invitations; every other change reaches every member', () => {
    const members = [
      { userId: 'u-owner', role: 'OWNER' as const },
      { userId: 'u-admin', role: 'ADMIN' as const },
      { userId: 'u-member', role: 'MEMBER' as const },
    ];
    expect(orgChangeRecipients(members, 'invitations')).toEqual(['u-owner', 'u-admin']);
    for (const change of ['membership', 'profile', 'status', 'policy', 'deleted'] as const) {
      expect(orgChangeRecipients(members, change)).toEqual(['u-owner', 'u-admin', 'u-member']);
    }
  });

  it('JOURNEYS-3 a spend-preference change is one spend:preferences on the person\u2019s own notifications room, carrying only their id', () => {
    const msg = spendPreferencesMessage({ userId: 'u-1' });
    expect(msg).toEqual({ channelId: 'notifications:u-1', event: SPEND_PREFERENCES_EVENT, payload: { userId: 'u-1' } });
    expect(SPEND_PREFERENCES_EVENT).toBe('spend:preferences');
    expect(JSON.stringify(msg)).not.toMatch(/Cents|Credits|walletId|source/);
  });
});

describe('the broadcast send edge', () => {
  it('JOURNEYS-3 with a realtime server configured, the preference announcement posts one signed broadcast', async () => {
    const previous = process.env.INTERNAL_REALTIME_URL;
    const calls: Array<{ url: string; body: string }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.INTERNAL_REALTIME_URL = 'http://127.0.0.1:1';
    try {
      await emitSpendPreferencesChanged({ userId: 'u-9' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('http://127.0.0.1:1/api/broadcast');
      expect(calls[0]!.body).toContain('"event":"spend:preferences"');
    } finally {
      if (previous === undefined) delete process.env.INTERNAL_REALTIME_URL;
      else process.env.INTERNAL_REALTIME_URL = previous;
      vi.unstubAllGlobals();
    }
  });

  it('a refusing realtime server is logged and contained: every emit resolves', async () => {
    const previous = process.env.INTERNAL_REALTIME_URL;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 503 })));
    process.env.INTERNAL_REALTIME_URL = 'http://127.0.0.1:1';
    try {
      await expect(emitSpendPreferencesChanged({ userId: 'u-9' })).resolves.toBeUndefined();
      await expect(emitWalletChanged({ driveId: 'd-1', walletId: 'w-1', change: 'balance' })).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.INTERNAL_REALTIME_URL;
      else process.env.INTERNAL_REALTIME_URL = previous;
      vi.unstubAllGlobals();
    }
  });

  it('a dead realtime server is contained the same way', async () => {
    const previous = process.env.INTERNAL_REALTIME_URL;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    process.env.INTERNAL_REALTIME_URL = 'http://127.0.0.1:1';
    try {
      await expect(emitWalletChanged({ driveId: 'd-1', walletId: 'w-1', change: 'balance' })).resolves.toBeUndefined();
      await expect(emitSpendPreferencesChanged({ userId: 'u-9' })).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.INTERNAL_REALTIME_URL;
      else process.env.INTERNAL_REALTIME_URL = previous;
      vi.unstubAllGlobals();
    }
  });
});
