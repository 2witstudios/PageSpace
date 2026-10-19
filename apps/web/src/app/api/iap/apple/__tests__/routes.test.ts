/**
 * Wiring of the App Store routes: auth, body parsing, verification failures, and the
 * status the device finishes on. Verification and funding themselves run for real
 * against signed fixtures and Postgres in packages/lib (apple-verify.test.ts,
 * apple-funding.integration.test.ts); here they are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';
import type { SessionAuthResult } from '@/lib/auth';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  verifyTransaction: vi.fn(),
  verifyNotification: vi.fn(),
  applyAppleTransaction: vi.fn(),
  applyAppleNotification: vi.fn(),
  getOrCreateAccountToken: vi.fn(),
  emitCreditsUpdated: vi.fn(),
  isBillingEnabled: vi.fn(() => true),
  insertValues: vi.fn(),
  selectRows: vi.fn(),
  updateSet: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: mocks.auth,
  isAuthError: (r: unknown) => typeof r === 'object' && r !== null && 'error' in r,
}));
vi.mock('@pagespace/lib/billing/apple/apple-verify', async () => {
  class AppleVerificationError extends Error {
    constructor(public readonly failure: string, message: string) { super(message); }
  }
  return {
    AppleVerificationError,
    getAppleVerifier: () => ({
      config: { bundleId: 'ai.pagespace.ios', allowSandbox: true },
      verifier: { verifyTransaction: mocks.verifyTransaction, verifyNotification: mocks.verifyNotification },
    }),
  };
});
vi.mock('@pagespace/lib/billing/apple/apple-funding', () => ({
  applyAppleTransaction: mocks.applyAppleTransaction,
  applyAppleNotification: mocks.applyAppleNotification,
}));
vi.mock('@pagespace/lib/billing/apple/apple-account', () => ({ getOrCreateAccountToken: mocks.getOrCreateAccountToken }));
vi.mock('@pagespace/lib/deployment-mode', () => ({ isBillingEnabled: mocks.isBillingEnabled }));
vi.mock('@/lib/subscription/credit-balance', () => ({
  emitCreditsUpdated: mocks.emitCreditsUpdated,
  getCreditBalance: async () => ({ topup: { remaining: 2500 } }),
}));
vi.mock('@/lib/stripe/price-config', () => ({ getPersonalTierFromPrice: () => 'free' }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/app-store', () => ({ appStoreNotifications: { notificationUUID: 'uuid', processedAt: 'processedAt' } }));
vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: () => ({ values: (v: unknown) => { mocks.insertValues(v); return { onConflictDoNothing: async () => undefined }; } }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.selectRows() }) }) }),
    update: () => ({ set: (v: unknown) => { mocks.updateSet(v); return { where: () => Object.assign(Promise.resolve(undefined), { catch: () => undefined }) }; } }),
  },
}));

import { AppleVerificationError } from '@pagespace/lib/billing/apple/apple-verify';
import { POST as postTransaction } from '../transactions/route';
import { POST as postNotification } from '../notifications/route';
import { POST as postAccountToken } from '../account-token/route';

const JWS = 'eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ.c2ln';
const session = (userId = 'user_1'): SessionAuthResult => ({ userId, tokenVersion: 0, tokenType: 'session', sessionId: 's', adminRoleVersion: 0, role: 'user' });
const req = (url: string, body: unknown) =>
  new Request(`https://example.com${url}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isBillingEnabled.mockReturnValue(true);
  mocks.auth.mockResolvedValue(session());
  mocks.verifyTransaction.mockResolvedValue({ transactionId: '2000000000000001' });
  mocks.applyAppleTransaction.mockResolvedValue({ result: 'applied', kind: 'consumable', subscriptionTier: 'free' });
  mocks.selectRows.mockReturnValue([{ processedAt: null }]);
});

describe('POST /api/iap/apple/transactions', () => {
  it('requires a session with CSRF', async () => {
    mocks.auth.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await postTransaction(req('/api/iap/apple/transactions', { signedTransaction: JWS }))).status).toBe(401);
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), { allow: ['session'], requireCSRF: true });
    expect(mocks.verifyTransaction).not.toHaveBeenCalled();
  });

  it('applies a verified transaction for the signed-in caller and refreshes their balance', async () => {
    const res = await postTransaction(req('/api/iap/apple/transactions', { signedTransaction: JWS }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'applied', kind: 'consumable', subscriptionTier: 'free', balance: { topup: { remaining: 2500 } } });
    expect(mocks.verifyTransaction).toHaveBeenCalledWith(JWS);
    expect(mocks.applyAppleTransaction).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user_1',
      decoded: { transactionId: '2000000000000001' },
      config: { bundleId: 'ai.pagespace.ios', allowSandbox: true },
    }));
    expect(mocks.emitCreditsUpdated).toHaveBeenCalledWith('user_1');
  });

  it('answers 422 with the reason for a refusal, and does not refresh anything', async () => {
    mocks.applyAppleTransaction.mockResolvedValue({ result: 'refused', reason: 'account_mismatch' });
    const res = await postTransaction(req('/api/iap/apple/transactions', { signedTransaction: JWS }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'refused', reason: 'account_mismatch' });
    expect(mocks.emitCreditsUpdated).not.toHaveBeenCalled();
  });

  it('answers 400 for a body that is not a JWS, without verifying', async () => {
    expect((await postTransaction(req('/api/iap/apple/transactions', 'nope'))).status).toBe(400);
    expect((await postTransaction(req('/api/iap/apple/transactions', { signedTransaction: 'x' }))).status).toBe(400);
    expect(mocks.verifyTransaction).not.toHaveBeenCalled();
  });

  it('answers 400 for a signature that does not verify, and 503 for one that could verify later', async () => {
    mocks.verifyTransaction.mockRejectedValueOnce(new AppleVerificationError('invalid_signature', 'did not verify'));
    expect((await postTransaction(req('/api/iap/apple/transactions', { signedTransaction: JWS }))).status).toBe(400);
    mocks.verifyTransaction.mockRejectedValueOnce(new AppleVerificationError('retryable', 'try later'));
    expect((await postTransaction(req('/api/iap/apple/transactions', { signedTransaction: JWS }))).status).toBe(503);
    expect(mocks.applyAppleTransaction).not.toHaveBeenCalled();
  });

  it('answers 500 when applying fails, so the device keeps the transaction for a retry', async () => {
    mocks.applyAppleTransaction.mockRejectedValue(new Error('db down'));
    expect((await postTransaction(req('/api/iap/apple/transactions', { signedTransaction: JWS }))).status).toBe(500);
  });
});

describe('POST /api/iap/apple/notifications', () => {
  const verified = { notificationUUID: 'n-1', type: 'DID_RENEW', subtype: null, status: 1, transaction: { transactionId: 't' }, renewal: null };

  it('needs no session: the signed payload is verified, claimed, applied and marked processed', async () => {
    mocks.verifyNotification.mockResolvedValue(verified);
    mocks.applyAppleNotification.mockResolvedValue({ result: 'applied', kind: 'subscription', subscriptionTier: 'pro', userId: 'user_9' });
    const res = await postNotification(req('/api/iap/apple/notifications', { signedPayload: JWS }));
    expect(res.status).toBe(200);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining({ notificationUUID: 'n-1', type: 'DID_RENEW' }));
    expect(mocks.updateSet).toHaveBeenCalledWith(expect.objectContaining({ processedAt: expect.any(Date), error: null }));
    expect(mocks.emitCreditsUpdated).toHaveBeenCalledWith('user_9');
  });

  it('acks a redelivery of a processed notification without applying it again', async () => {
    mocks.verifyNotification.mockResolvedValue(verified);
    mocks.selectRows.mockReturnValue([{ processedAt: new Date() }]);
    const res = await postNotification(req('/api/iap/apple/notifications', { signedPayload: JWS }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, result: 'duplicate' });
    expect(mocks.applyAppleNotification).not.toHaveBeenCalled();
  });

  it('acks a refusal (a retry cannot change it) and records the reason', async () => {
    mocks.verifyNotification.mockResolvedValue(verified);
    mocks.applyAppleNotification.mockResolvedValue({ result: 'refused', reason: 'account_mismatch' });
    expect((await postNotification(req('/api/iap/apple/notifications', { signedPayload: JWS }))).status).toBe(200);
    expect(mocks.updateSet).toHaveBeenCalledWith(expect.objectContaining({ processedAt: expect.any(Date), error: 'account_mismatch' }));
  });

  it('given a buyer it cannot resolve yet, records the error, leaves it unprocessed and answers non-2xx so Apple retries', async () => {
    mocks.verifyNotification.mockResolvedValue(verified);
    mocks.applyAppleNotification.mockResolvedValue({ result: 'refused', reason: 'unknown_user' });
    expect((await postNotification(req('/api/iap/apple/notifications', { signedPayload: JWS }))).status).toBe(503);
    expect(mocks.updateSet).toHaveBeenCalledWith({ processedAt: null, error: 'unknown_user' });
  });

  it('answers 500 when applying fails, so Apple redelivers', async () => {
    mocks.verifyNotification.mockResolvedValue(verified);
    mocks.applyAppleNotification.mockRejectedValue(new Error('db down'));
    expect((await postNotification(req('/api/iap/apple/notifications', { signedPayload: JWS }))).status).toBe(500);
  });

  it('answers 400 for a payload that does not verify, before touching the database', async () => {
    mocks.verifyNotification.mockRejectedValue(new AppleVerificationError('invalid_signature', 'did not verify'));
    expect((await postNotification(req('/api/iap/apple/notifications', { signedPayload: JWS }))).status).toBe(400);
    expect((await postNotification(req('/api/iap/apple/notifications', { nothing: true }))).status).toBe(400);
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it('acks and ignores everything where billing is off', async () => {
    mocks.isBillingEnabled.mockReturnValue(false);
    expect((await postNotification(req('/api/iap/apple/notifications', { signedPayload: JWS }))).status).toBe(200);
    expect(mocks.verifyNotification).not.toHaveBeenCalled();
  });
});

describe('POST /api/iap/apple/account-token', () => {
  it("returns the caller's App Store account token", async () => {
    mocks.getOrCreateAccountToken.mockResolvedValue('6f1c0b9e-3c43-4b8f-9d7f-0b1a2c3d4e5f');
    const res = await postAccountToken(req('/api/iap/apple/account-token', {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountToken: '6f1c0b9e-3c43-4b8f-9d7f-0b1a2c3d4e5f' });
    expect(mocks.getOrCreateAccountToken).toHaveBeenCalledWith('user_1');
  });

  it('requires a session with CSRF', async () => {
    mocks.auth.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await postAccountToken(req('/api/iap/apple/account-token', {}))).status).toBe(401);
    expect(mocks.getOrCreateAccountToken).not.toHaveBeenCalled();
  });

  it('is unavailable where billing is off', async () => {
    mocks.isBillingEnabled.mockReturnValue(false);
    expect((await postAccountToken(req('/api/iap/apple/account-token', {}))).status).toBe(404);
  });
});
