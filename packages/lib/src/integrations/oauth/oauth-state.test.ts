import crypto from 'crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSignedState, verifySignedState } from './oauth-state';

const TEST_SECRET = 'test-secret-key-for-oauth-state';

describe('createSignedState', () => {
  it('should create a base64 encoded state string', () => {
    const state = createSignedState({ userId: 'user-1' }, TEST_SECRET);
    expect(state).toBeTruthy();
    // Should be valid base64
    expect(() => Buffer.from(state, 'base64')).not.toThrow();
  });

  it('should include a timestamp in the state', () => {
    const state = createSignedState({ userId: 'user-1' }, TEST_SECRET);
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
    expect(decoded.data.timestamp).toBeTypeOf('number');
  });
});

describe('verifySignedState', () => {
  it('should verify and decode a valid state', () => {
    const state = createSignedState({ userId: 'user-1', returnUrl: '/dashboard' }, TEST_SECRET);
    const decoded = verifySignedState<{ userId: string; returnUrl: string }>(state, TEST_SECRET);

    expect(decoded).not.toBeNull();
    expect(decoded?.userId).toBe('user-1');
    expect(decoded?.returnUrl).toBe('/dashboard');
  });

  it('should return null for tampered signature', () => {
    const state = createSignedState({ userId: 'user-1' }, TEST_SECRET);
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
    decoded.sig = 'tampered-signature-value-that-is-wrong';
    const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64');

    const result = verifySignedState(tampered, TEST_SECRET);
    expect(result).toBeNull();
  });

  it('should return null for wrong secret', () => {
    const state = createSignedState({ userId: 'user-1' }, TEST_SECRET);
    const result = verifySignedState(state, 'wrong-secret');
    expect(result).toBeNull();
  });

  it('should return null for invalid base64', () => {
    const result = verifySignedState('not-valid-base64!!!', TEST_SECRET);
    expect(result).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    const state = Buffer.from('not json').toString('base64');
    const result = verifySignedState(state, TEST_SECRET);
    expect(result).toBeNull();
  });

  it('should return null for missing data or sig', () => {
    const noSig = Buffer.from(JSON.stringify({ data: { userId: 'x' } })).toString('base64');
    expect(verifySignedState(noSig, TEST_SECRET)).toBeNull();

    const noData = Buffer.from(JSON.stringify({ sig: 'x' })).toString('base64');
    expect(verifySignedState(noData, TEST_SECRET)).toBeNull();
  });

  it('should return null for expired state', () => {
    // Create state with a timestamp in the past (>10 minutes ago)
    const oldTimestamp = Date.now() - 11 * 60 * 1000;
    const state = createSignedState({ userId: 'user-1' }, TEST_SECRET);

    // Tamper the timestamp to make it expired (need to re-sign)
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
    decoded.data.timestamp = oldTimestamp;

    // Re-sign with correct secret
    const newSig = crypto
      .createHmac('sha256', TEST_SECRET)
      .update(JSON.stringify(decoded.data))
      .digest('hex');
    decoded.sig = newSig;

    const expiredState = Buffer.from(JSON.stringify(decoded)).toString('base64');
    const result = verifySignedState(expiredState, TEST_SECRET);
    expect(result).toBeNull();
  });
});
