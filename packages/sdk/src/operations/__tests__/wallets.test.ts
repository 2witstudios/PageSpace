import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import { CONSUMER_WALLET_VIEW_KEYS, getConversationSpendSource, getDriveWallet, listMyWallets } from '../wallets.js';
import { loadAllOperations } from '../../__tests__/support/load-operations.js';

const config = { baseUrl: 'https://pagespace.ai' };

const parse = (op: Parameters<typeof parseResponse>[0], body: unknown) =>
  parseResponse(op, 200, new Headers(), JSON.stringify(body));

/** Exactly `ConsumerWalletView` (packages/lib/src/billing/wallet-views.ts). */
const consumerWallet = {
  viewer: 'member',
  walletId: 'w_drive',
  driveId: 'd1',
  status: 'active',
  remainingCents: 4200,
  remainingCredits: '4,200',
  myCap: { dailyRemainingCents: 300, monthlyRemainingCents: null, dailyRemainingCredits: '300', monthlyRemainingCredits: null },
  donationsEnabled: true,
  defaultSpendSource: 'drive_wallet',
};

const driveWalletBody = { viewer: 'member', actions: ['view'], wallet: consumerWallet };

/** `MyWallets` as a token reads it: `funds.pools` is always empty. */
const myWalletsBody = {
  personal: { walletId: 'w_me', remainingCents: 900, remainingCredits: '900', defaultSpendSource: null },
  driveWallets: [{ driveId: 'd1', walletId: 'w_drive', status: 'active', remainingCents: 4200, remainingCredits: '4,200' }],
  seats: [{ orgId: 'o1', walletId: 'w_pool' }],
  funds: {
    driveWallets: [{ driveId: 'd2', walletId: 'w_d2' }],
    pools: [],
    donations: [{ walletId: 'w_d3', driveId: 'd3', originalCents: 500, originalCredits: '500', remainingCents: 120, remainingCredits: '120', createdAt: '2026-09-01T00:00:00.000Z' }],
  },
};

const conversationBody = {
  conversationId: 'c1',
  driveId: 'd1',
  chosenWalletId: null,
  options: [
    { source: 'drive_wallet', walletId: 'w_drive' },
    { source: 'own_credits', walletId: 'w_me' },
  ],
  resolved: {
    kind: 'spend',
    source: 'drive_wallet',
    walletId: 'w_drive',
    fallbackApplied: false,
    fallbackFrom: null,
    entitlementTier: 'business',
  },
};

describe('wallets.getDriveWallet', () => {
  it('X-1 (partial) sends a bare GET to the drive wallet route', () => {
    const request = buildRequest(getDriveWallet, { driveId: 'd1' }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1/wallet');
    expect(request.body).toBeUndefined();
  });

  it('X-1 (partial) accepts exactly the consumer projection a token receives', () => {
    expect(parse(getDriveWallet, driveWalletBody)).toEqual(driveWalletBody);
    expect(Object.keys(consumerWallet).sort()).toEqual([...CONSUMER_WALLET_VIEW_KEYS].sort());
  });

  it('X-1 (partial) accepts a drive with no wallet and a guest viewer', () => {
    const body = { viewer: 'guest', actions: ['view'], wallet: null };
    expect(parse(getDriveWallet, body)).toEqual(body);
  });

  it('X-1 (partial) flags a response carrying the org pool instead of passing it through', () => {
    const leaked = { ...driveWalletBody, wallet: { ...consumerWallet, pool: { walletId: 'w_pool', availableCents: 1, unallocatedCents: 1 } } };
    expect(parse(getDriveWallet, leaked)).toBeInstanceOf(ResponseValidationError);
  });

  it('X-1 (partial) flags lead-only fields (allocation, spend by member) on a token read', () => {
    for (const [field, value] of [
      ['allocationCents', 10_000],
      ['spendByConsumer', []],
      ['spentCents', 5],
      ['fallbackRule', null],
    ] as const) {
      const leaked = { ...driveWalletBody, wallet: { ...consumerWallet, [field]: value } };
      expect(parse(getDriveWallet, leaked), field).toBeInstanceOf(ResponseValidationError);
    }
  });

  it('X-1 (partial) flags a lead/org-admin viewer or a write action offered to a token', () => {
    expect(parse(getDriveWallet, { ...driveWalletBody, viewer: 'lead' })).toBeInstanceOf(ResponseValidationError);
    expect(parse(getDriveWallet, { ...driveWalletBody, wallet: { ...consumerWallet, viewer: 'org_admin' } })).toBeInstanceOf(ResponseValidationError);
    expect(parse(getDriveWallet, { ...driveWalletBody, actions: ['view', 'top_up'] })).toBeInstanceOf(ResponseValidationError);
  });

  it('X-1 (partial) still strips an unknown additive field (ADR 0001 D5 open-world output)', () => {
    const body = { ...driveWalletBody, wallet: { ...consumerWallet, someFutureField: 1 } };
    expect(parse(getDriveWallet, body)).toEqual(driveWalletBody);
  });

  it('X-1 (partial) rejects a missing driveId and unknown input fields', () => {
    expect(getDriveWallet.inputSchema.safeParse({}).success).toBe(false);
    expect(getDriveWallet.inputSchema.safeParse({ driveId: 'd1', allocationCents: 5 }).success).toBe(false);
  });
});

describe('wallets.list', () => {
  it('X-1 (partial) sends a bare GET to /api/wallets', () => {
    const request = buildRequest(listMyWallets, {}, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/wallets');
    expect(request.body).toBeUndefined();
  });

  it('X-1 (partial) accepts MyWallets as a token reads it', () => {
    expect(parse(listMyWallets, myWalletsBody)).toEqual(myWalletsBody);
  });

  it('X-1 (partial) flags a pool balance returned to a token', () => {
    const leaked = {
      ...myWalletsBody,
      funds: { ...myWalletsBody.funds, pools: [{ orgId: 'o1', walletId: 'w_pool', availableCents: 1, unallocatedCents: 1 }] },
    };
    expect(parse(listMyWallets, leaked)).toBeInstanceOf(ResponseValidationError);
  });
});

describe('wallets.getConversationSource', () => {
  it('X-1 (partial) interpolates :conversationId with no query for a drive conversation', () => {
    const request = buildRequest(getConversationSpendSource, { conversationId: 'c1' }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/wallets/conversations/c1');
    expect(request.body).toBeUndefined();
  });

  it('X-1 (partial) sends driveId as a query parameter for a global conversation', () => {
    const request = buildRequest(getConversationSpendSource, { conversationId: 'c1', driveId: 'd9' }, config);
    expect(request.url).toBe('https://pagespace.ai/api/wallets/conversations/c1?driveId=d9');
  });

  it('X-1 (partial) accepts each kind of resolved decision', () => {
    expect(parse(getConversationSpendSource, conversationBody)).toEqual(conversationBody);
    const refuse = {
      ...conversationBody,
      driveId: null,
      chosenWalletId: 'w_gone',
      resolved: { kind: 'refuse', source: null, reason: 'chosen_wallet_unavailable', options: [{ source: 'own_credits', walletId: 'w_me' }], chargeCents: 0 },
    };
    expect(parse(getConversationSpendSource, refuse)).toEqual(refuse);
    const skip = { ...conversationBody, resolved: { kind: 'skip', reason: 'no_drive_wallet', walletId: null, chargeCents: 0 } };
    expect(parse(getConversationSpendSource, skip)).toEqual(skip);
  });

  it('X-1 (partial) rejects an unknown decision kind', () => {
    const body = { ...conversationBody, resolved: { kind: 'maybe' } };
    expect(parse(getConversationSpendSource, body)).toBeInstanceOf(ResponseValidationError);
  });
});

describe('wallet operations — [D-OW-26] read-only surface', () => {
  it('X-1 (partial) every wallets.* operation in the registry is a GET (a token never moves money or changes a source)', () => {
    const walletOps = loadAllOperations().filter((op) => op.name.startsWith('wallets.'));
    expect(walletOps.map((op) => op.name).sort()).toEqual(['wallets.getConversationSource', 'wallets.getDriveWallet', 'wallets.list']);
    expect(walletOps.every((op) => op.method === 'GET')).toBe(true);
  });

  it('X-1 (partial) the two account-wide reads declare account scope; the drive read declares drive scope', () => {
    expect(getDriveWallet.requiredScope).toBe('drive');
    expect(listMyWallets.requiredScope).toBe('account');
    expect(getConversationSpendSource.requiredScope).toBe('account');
  });
});
