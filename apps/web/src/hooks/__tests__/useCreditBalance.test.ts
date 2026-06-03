/**
 * useCreditBalance — pure-logic tests.
 *
 * The hook itself wires SWR + a Socket.IO listener and can't be rendered in the .pu
 * worktree (dual-React). We instead test the two pure pieces the socket handler is
 * built from: how an authoritative `credits:updated` payload maps into the cached
 * balance, and the mutate options used to apply it (must NOT revalidate — a refetch
 * would race the already-authoritative payload and reintroduce the balance flicker).
 */
import { describe, it, expect, vi } from 'vitest';

// Keep the module import side-effect-free: stub the heavy client deps.
vi.mock('swr', () => ({ default: vi.fn(() => ({ data: undefined, error: undefined, isLoading: true, mutate: vi.fn() })) }));
vi.mock('@/stores/useSocketStore', () => ({ useSocketStore: vi.fn(() => undefined) }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));

import { applyCreditsPayload, CREDITS_PUSH_MUTATE_OPTIONS, type CreditBalance } from '../useCreditBalance';
import type { CreditsEventPayload } from '@/lib/websocket';

const payload = {
  userId: 'u1',
  operation: 'updated',
  billingEnabled: true,
  monthly: { remaining: 300, allowance: 500, periodEnd: null },
  topup: { remaining: 100 },
  spendable: 400,
  reserved: 25,
} as CreditsEventPayload;

describe('applyCreditsPayload', () => {
  it('maps the authoritative socket payload into the cached balance', () => {
    const next = applyCreditsPayload(payload, undefined);
    expect(next).toMatchObject({
      billingEnabled: true,
      spendable: 400,
      reserved: 25,
      monthly: payload.monthly,
      topup: payload.topup,
    });
  });

  it('preserves the process-level creditsMode from the current cache (payload omits it)', () => {
    const current = { creditsMode: true } as CreditBalance;
    expect(applyCreditsPayload(payload, current).creditsMode).toBe(true);
  });

  it('defaults creditsMode to false when there is no current cache', () => {
    expect(applyCreditsPayload(payload, undefined).creditsMode).toBe(false);
  });
});

describe('CREDITS_PUSH_MUTATE_OPTIONS', () => {
  it('does NOT revalidate — the payload is authoritative; a refetch would race it', () => {
    expect(CREDITS_PUSH_MUTATE_OPTIONS.revalidate).toBe(false);
  });
});
