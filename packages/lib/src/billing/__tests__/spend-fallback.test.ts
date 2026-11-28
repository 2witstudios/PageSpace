import { describe, it, expect } from 'vitest';
import {
  SPEND_FALLBACK_FROM_HEADER,
  SPEND_FALLBACK_TO_HEADER,
  SPEND_FALLBACK_WALLET_HEADER,
  spendFallbackNotice,
  spendFallbackHeaders,
  readSpendFallbackHeaders,
  readSpendFallbackBody,
} from '../spend-fallback';

const fellBack = { allowed: true, walletId: 'w-marcus', fallback: { from: 'drive_wallet', to: 'own_credits' } } as const;
const spentAsNamed = { allowed: true, walletId: 'w-product' } as const;

describe('spend-fallback: the one shape every entry point reports a fallback in', () => {
  it('SPEND-4 (partial) a gate that fell back yields the notice: the source chosen, the source held, the wallet held', () => {
    expect(spendFallbackNotice(fellBack)).toEqual({ from: 'drive_wallet', to: 'own_credits', walletId: 'w-marcus' });
  });

  it('SPEND-4 (partial) a gate that spent the source it named, refused, or never ran yields no notice', () => {
    expect(spendFallbackNotice(spentAsNamed)).toBeNull();
    expect(spendFallbackNotice({ allowed: false, fallback: { from: 'drive_wallet', to: 'own_credits' } })).toBeNull();
    expect(spendFallbackNotice(null)).toBeNull();
    expect(spendFallbackNotice(undefined)).toBeNull();
  });

  it('SPEND-4 (partial) the notice travels as three response headers and reads back unchanged', () => {
    const notice = spendFallbackNotice(fellBack);
    const headers = spendFallbackHeaders(notice);
    expect(headers).toEqual({
      [SPEND_FALLBACK_FROM_HEADER]: 'drive_wallet',
      [SPEND_FALLBACK_TO_HEADER]: 'own_credits',
      [SPEND_FALLBACK_WALLET_HEADER]: 'w-marcus',
    });
    expect(readSpendFallbackHeaders(new Headers(headers))).toEqual(notice);
  });

  it('no fallback sets no header, and headers that name no valid source read as no fallback', () => {
    expect(spendFallbackHeaders(null)).toEqual({});
    expect(readSpendFallbackHeaders(new Headers())).toBeNull();
    expect(readSpendFallbackHeaders(new Headers({ [SPEND_FALLBACK_FROM_HEADER]: 'pool', [SPEND_FALLBACK_TO_HEADER]: 'own_credits' }))).toBeNull();
  });

  it('SPEND-4 (partial) a JSON body carries the same notice, read back unchanged across a process hop', () => {
    const notice = spendFallbackNotice(fellBack);
    expect(readSpendFallbackBody(JSON.parse(JSON.stringify(notice)))).toEqual(notice);
    expect(readSpendFallbackBody(null)).toBeNull();
    expect(readSpendFallbackBody({ from: 'drive_wallet', to: 'everything' })).toBeNull();
    expect(readSpendFallbackBody({ from: 'drive_wallet', to: 'own_credits' })).toEqual({ from: 'drive_wallet', to: 'own_credits', walletId: null });
  });
});
