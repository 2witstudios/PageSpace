import { describe, expect, it, vi } from 'vitest';
import {
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  buildOperationRegistry,
  extractConversationSourceArgs,
  extractDriveWalletArgs,
  parseArgv,
  renderConversationSource,
  renderDriveWallet,
  renderMyWallets,
  walletsDriveHandler,
  walletsListHandler,
  walletsSourceHandler,
} from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { listOperations } from '@pagespace/sdk';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const CONSUMER_WALLET = {
  viewer: 'member' as const,
  walletId: 'w_drive',
  driveId: 'd1',
  status: 'active' as const,
  remainingCents: 420_000,
  myCap: { dailyRemainingCents: 300, monthlyRemainingCents: null },
  donationsEnabled: true,
  defaultSpendSource: 'drive_wallet' as const,
};

const DRIVE_WALLET = { viewer: 'member' as const, actions: ['view' as const], wallet: CONSUMER_WALLET };

const MY_WALLETS = {
  personal: { walletId: 'w_me', remainingCents: 1_250, defaultSpendSource: null },
  driveWallets: [{ driveId: 'd1', walletId: 'w_drive', status: 'active' as const, remainingCents: 420_000 }],
  seats: [{ orgId: 'o1', walletId: 'w_pool' }],
  funds: {
    driveWallets: [],
    pools: [],
    donations: [{ walletId: 'w_d3', driveId: 'd3', originalCents: 500, remainingCents: 120, createdAt: '2026-09-01T12:00:00.000Z' }],
  },
};

const SOURCE = {
  conversationId: 'c1',
  driveId: 'd1',
  chosenWalletId: null,
  options: [
    { source: 'drive_wallet' as const, walletId: 'w_drive' },
    { source: 'own_credits' as const, walletId: 'w_me' },
  ],
  resolved: {
    kind: 'spend' as const,
    source: 'drive_wallet' as const,
    walletId: 'w_drive',
    fallbackApplied: false,
    fallbackFrom: null,
    entitlementTier: 'business' as const,
  },
};

describe('wallets argv', () => {
  it('X-1 (partial) drive takes exactly one driveId', () => {
    expect(extractDriveWalletArgs(['d1'])).toEqual({ ok: true, value: { driveId: 'd1' } });
    expect(extractDriveWalletArgs([]).ok).toBe(false);
    expect(extractDriveWalletArgs(['d1', 'd2']).ok).toBe(false);
    expect(extractDriveWalletArgs(['--allocation']).ok).toBe(false);
  });

  it('X-1 (partial) source takes a conversationId and an optional --drive', () => {
    expect(extractConversationSourceArgs(['c1'])).toEqual({ ok: true, value: { conversationId: 'c1' } });
    expect(extractConversationSourceArgs(['c1', '--drive', 'd9'])).toEqual({ ok: true, value: { conversationId: 'c1', driveId: 'd9' } });
    expect(extractConversationSourceArgs(['--drive', 'd9', 'c1'])).toEqual({ ok: true, value: { conversationId: 'c1', driveId: 'd9' } });
  });

  it('X-1 (partial) source refuses a missing conversationId, a valueless --drive, an extra positional and unknown flags', () => {
    expect(extractConversationSourceArgs([]).ok).toBe(false);
    expect(extractConversationSourceArgs(['--drive', 'd9']).ok).toBe(false);
    expect(extractConversationSourceArgs(['c1', '--drive']).ok).toBe(false);
    expect(extractConversationSourceArgs(['c1', 'c2']).ok).toBe(false);
    expect(extractConversationSourceArgs(['c1', '--wallet', 'w1']).ok).toBe(false);
  });
});

describe('wallets rendering', () => {
  it('X-1 (partial) renders credit amounts as credits, never with a currency symbol', () => {
    const text = renderDriveWallet('d1', DRIVE_WALLET);
    expect(text).toContain('remaining: 420,000 credits');
    expect(text).toContain('300 credits left today');
    expect(text).toContain('no monthly cap');
    expect(text).toContain('default source: drive wallet');
    expect(text).not.toMatch(/\$/);
  });

  it('X-1 (partial) says so when the drive has no wallet', () => {
    expect(renderDriveWallet('d1', { viewer: 'guest', actions: ['view'], wallet: null })).toBe('Drive d1 has no wallet.\n');
  });

  it('X-1 (partial) renders my wallets with every section, empty ones as (none)', () => {
    const text = renderMyWallets(MY_WALLETS);
    expect(text).toContain('Your wallet w_me  remaining: 1,250 credits  default source: (none)');
    expect(text).toContain('d1  w_drive  [active]  remaining: 420,000 credits');
    expect(text).toContain('o1  w_pool');
    expect(text).toMatch(/Drive wallets your wallet funds:\n {2}\(none\)/);
    expect(text).toContain('120 credits left of 500 credits  2026-09-01');
    expect(text).not.toMatch(/\$/);
  });

  it('X-1 (partial) renders each kind of resolved decision', () => {
    expect(renderConversationSource(SOURCE)).toContain('next call: spends from drive wallet (w_drive)');
    const refused = renderConversationSource({
      ...SOURCE,
      chosenWalletId: 'w_gone',
      resolved: { kind: 'refuse', source: null, reason: 'chosen_wallet_unavailable', options: [{ source: 'own_credits', walletId: 'w_me' }], chargeCents: 0 },
    });
    expect(refused).toContain('chosen wallet: w_gone');
    expect(refused).toContain('next call: refused: chosen_wallet_unavailable (could spend: own credits)');
    const skipped = renderConversationSource({ ...SOURCE, resolved: { kind: 'skip', reason: 'no_drive_wallet', walletId: null, chargeCents: 0 } });
    expect(skipped).toContain('next call: not charged: no_drive_wallet');
  });
});

describe('pagespace wallets drive', () => {
  it('X-1 (partial) reads the drive wallet and prints it', async () => {
    const getDriveWallet = vi.fn(async () => DRIVE_WALLET);
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ wallets: { getDriveWallet } }), stdout });
    expect(await walletsDriveHandler(ctx, commandIntent(['d1']))).toBe(EXIT_SUCCESS);
    expect(getDriveWallet).toHaveBeenCalledWith({ driveId: 'd1' });
    expect(stdout.lines.join('')).toContain('420,000 credits');
  });

  it('X-1 (partial) --json prints the raw result', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ wallets: { getDriveWallet: async () => DRIVE_WALLET } }), stdout });
    expect(await walletsDriveHandler(ctx, commandIntent(['d1', '--json']))).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(DRIVE_WALLET);
  });

  it('X-1 (partial) a missing driveId is a usage error and calls nothing', async () => {
    const getDriveWallet = vi.fn();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ wallets: { getDriveWallet } }), stderr });
    expect(await walletsDriveHandler(ctx, commandIntent([]))).toBe(EXIT_USAGE_ERROR);
    expect(getDriveWallet).not.toHaveBeenCalled();
    expect(stderr.lines.join('')).toContain('Usage: pagespace wallets drive <driveId>');
  });

  it("X-1 (partial) a server refusal is a runtime error with the server's message", async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({
      sdk: fakeSdk({ wallets: { getDriveWallet: async () => { throw new Error('Drive not found'); } } }),
      stderr,
    });
    expect(await walletsDriveHandler(ctx, commandIntent(['d1']))).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Drive not found');
  });
});

describe('pagespace wallets list', () => {
  it('X-1 (partial) lists my wallets', async () => {
    const list = vi.fn(async () => MY_WALLETS);
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ wallets: { list } }), stdout });
    expect(await walletsListHandler(ctx, commandIntent([]))).toBe(EXIT_SUCCESS);
    expect(list).toHaveBeenCalledWith({});
    expect(stdout.lines.join('')).toContain('Your wallet w_me');
  });

  it('X-1 (partial) refuses stray arguments', async () => {
    const list = vi.fn();
    const ctx = createFakeContext({ sdk: fakeSdk({ wallets: { list } }) });
    expect(await walletsListHandler(ctx, commandIntent(['extra']))).toBe(EXIT_USAGE_ERROR);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('pagespace wallets source', () => {
  it('X-1 (partial) passes the conversation and the optional drive through', async () => {
    const getConversationSource = vi.fn(async () => SOURCE);
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ wallets: { getConversationSource } }), stdout });
    expect(await walletsSourceHandler(ctx, commandIntent(['c1', '--drive', 'd9']))).toBe(EXIT_SUCCESS);
    expect(getConversationSource).toHaveBeenCalledWith({ conversationId: 'c1', driveId: 'd9' });
    expect(stdout.lines.join('')).toContain('Conversation c1');
  });

  it('X-1 (partial) a missing conversationId is a usage error and calls nothing', async () => {
    const getConversationSource = vi.fn();
    const ctx = createFakeContext({ sdk: fakeSdk({ wallets: { getConversationSource } }) });
    expect(await walletsSourceHandler(ctx, commandIntent([]))).toBe(EXIT_USAGE_ERROR);
    expect(getConversationSource).not.toHaveBeenCalled();
  });
});

describe('pagespace mcp — wallet tools', () => {
  it('X-1 (partial) serves the three wallet reads and no wallet write', () => {
    const walletOps = listOperations(buildOperationRegistry()).filter((op) => op.name.startsWith('wallets.'));
    expect(walletOps.map((op) => op.name).sort()).toEqual(['wallets.getConversationSource', 'wallets.getDriveWallet', 'wallets.list']);
    expect(walletOps.every((op) => op.method === 'GET')).toBe(true);
  });
});
