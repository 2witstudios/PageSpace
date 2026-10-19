import { describe, it, expect } from 'vitest';
import { notificationReply, readJwsField, transactionReply, verificationFailureReply } from '../apple-http';

describe('verificationFailureReply', () => {
  it('answers 400 for a payload that will never verify, so the device finishes it', () => {
    expect(verificationFailureReply('malformed').status).toBe(400);
    expect(verificationFailureReply('invalid_signature').status).toBe(400);
  });

  it('answers 503 for what could verify later, so the device keeps it for a retry', () => {
    expect(verificationFailureReply('not_configured').status).toBe(503);
    expect(verificationFailureReply('retryable').status).toBe(503);
  });
});

describe('transactionReply', () => {
  it('reports what was applied and the tier it left', () => {
    expect(transactionReply({ result: 'applied', kind: 'subscription', subscriptionTier: 'pro' })).toEqual({
      status: 200,
      body: { result: 'applied', kind: 'subscription', subscriptionTier: 'pro' },
    });
    expect(transactionReply({ result: 'duplicate', kind: 'consumable', subscriptionTier: 'free' }).status).toBe(200);
  });

  it('answers 422 with the reason for a permanent refusal', () => {
    expect(transactionReply({ result: 'refused', reason: 'account_mismatch' })).toEqual({
      status: 422,
      body: { error: 'refused', reason: 'account_mismatch' },
    });
  });
});

describe('notificationReply', () => {
  it('acks every final outcome so Apple stops redelivering', () => {
    expect(notificationReply({ result: 'test' }).status).toBe(200);
    expect(notificationReply({ result: 'ignored', reason: 'type' }).status).toBe(200);
    expect(notificationReply({ result: 'refused', reason: 'unknown_user' }).status).toBe(200);
    expect(notificationReply({ result: 'applied', kind: 'revoked', subscriptionTier: 'free' }).body).toEqual({ received: true, result: 'applied' });
  });
});

describe('readJwsField', () => {
  const jws = 'eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ.c2ln';

  it('reads a compact JWS out of the body', () => {
    expect(readJwsField({ signedTransaction: jws }, 'signedTransaction')).toBe(jws);
    expect(readJwsField({ signedPayload: jws }, 'signedPayload')).toBe(jws);
  });

  it('refuses anything that is not one', () => {
    expect(readJwsField(null, 'signedTransaction')).toBeNull();
    expect(readJwsField('x', 'signedTransaction')).toBeNull();
    expect(readJwsField({ signedTransaction: 42 }, 'signedTransaction')).toBeNull();
    expect(readJwsField({ signedTransaction: '' }, 'signedTransaction')).toBeNull();
    expect(readJwsField({ signedTransaction: 'a.b' }, 'signedTransaction')).toBeNull();
    expect(readJwsField({ signedTransaction: 'a.b.c d' }, 'signedTransaction')).toBeNull();
    expect(readJwsField({ signedTransaction: `${'a'.repeat(64_001)}.b.c` }, 'signedTransaction')).toBeNull();
    expect(readJwsField({ signedPayload: jws }, 'signedTransaction')).toBeNull();
  });
});
