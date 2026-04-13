import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { verifyOAuthState } from '../oauth-state';

const SECRET = 'test-oauth-state-secret';

function createState(data: Record<string, unknown>): string {
  const payload = JSON.stringify(data);
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ data, sig })).toString('base64');
}

describe('verifyOAuthState', () => {
  const originalEnv = process.env.OAUTH_STATE_SECRET;

  beforeEach(() => {
    process.env.OAUTH_STATE_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OAUTH_STATE_SECRET;
    } else {
      process.env.OAUTH_STATE_SECRET = originalEnv;
    }
    vi.restoreAllMocks();
  });

  it('returns valid for correctly signed state', () => {
    const state = createState({ returnUrl: '/dashboard', platform: 'web', timestamp: Date.now() });
    const result = verifyOAuthState(state);
    expect(result.status).toBe('valid');
  });

  it('returns invalid_signature for tampered signature', () => {
    const state = Buffer.from(JSON.stringify({
      data: { returnUrl: '/dashboard' },
      sig: 'bad-signature',
    })).toString('base64');
    const result = verifyOAuthState(state);
    expect(result.status).toBe('invalid_signature');
  });

  it('returns unsigned for state without sig field', () => {
    const state = Buffer.from(JSON.stringify({ returnUrl: '/custom' })).toString('base64');
    const result = verifyOAuthState(state);
    expect(result).toEqual({ status: 'unsigned', returnUrl: '/custom' });
  });

  it('returns malformed for unparseable state', () => {
    const result = verifyOAuthState('not-valid-base64!!!');
    expect(result.status).toBe('malformed');
  });

  it('returns invalid_signature when OAUTH_STATE_SECRET is missing', () => {
    delete process.env.OAUTH_STATE_SECRET;
    const state = createState({ returnUrl: '/dashboard' });
    const result = verifyOAuthState(state);
    expect(result.status).toBe('invalid_signature');
  });

  it('returns expired for state older than 10 minutes', () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    const state = createState({ returnUrl: '/dashboard', platform: 'web', timestamp: elevenMinutesAgo });
    const result = verifyOAuthState(state);
    expect(result.status).toBe('expired');
  });

  it('returns valid for state within 10-minute window', () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const state = createState({ returnUrl: '/dashboard', platform: 'web', timestamp: fiveMinutesAgo });
    const result = verifyOAuthState(state);
    expect(result.status).toBe('valid');
  });

  it('returns malformed for state without timestamp', () => {
    const state = createState({ returnUrl: '/dashboard', platform: 'web' });
    const result = verifyOAuthState(state);
    expect(result.status).toBe('malformed');
  });

  it('returns malformed for state with NaN timestamp', () => {
    const state = createState({ returnUrl: '/dashboard', platform: 'web', timestamp: NaN });
    const result = verifyOAuthState(state);
    expect(result.status).toBe('malformed');
  });

  it('returns malformed for state with Infinity timestamp', () => {
    const state = createState({ returnUrl: '/dashboard', platform: 'web', timestamp: Infinity });
    const result = verifyOAuthState(state);
    expect(result.status).toBe('malformed');
  });

  it('returns malformed for state with unknown platform value', () => {
    const state = createState({
      returnUrl: '/dashboard',
      platform: 'android',
      timestamp: Date.now(),
    });
    const result = verifyOAuthState(state);
    expect(result.status).toBe('malformed');
  });

  it('returns malformed for deviceId longer than 128 chars', () => {
    const state = createState({
      platform: 'desktop',
      deviceId: 'x'.repeat(129),
      timestamp: Date.now(),
    });
    const result = verifyOAuthState(state);
    expect(result.status).toBe('malformed');
  });

  it('returns malformed for returnUrl longer than 2048 chars', () => {
    const state = createState({
      returnUrl: '/' + 'a'.repeat(2048),
      platform: 'web',
      timestamp: Date.now(),
    });
    const result = verifyOAuthState(state);
    expect(result.status).toBe('malformed');
  });

  it('returns malformed for deviceName longer than 255 chars', () => {
    const state = createState({
      platform: 'desktop',
      deviceId: 'dev-123',
      deviceName: 'n'.repeat(256),
      timestamp: Date.now(),
    });
    const result = verifyOAuthState(state);
    expect(result.status).toBe('malformed');
  });

  it('extracts data fields from valid state', () => {
    const now = Date.now();
    const state = createState({
      returnUrl: '/settings',
      platform: 'desktop',
      deviceId: 'dev-123',
      deviceName: 'My Mac',
      timestamp: now,
    });
    const result = verifyOAuthState(state);
    expect(result).toEqual({
      status: 'valid',
      data: {
        returnUrl: '/settings',
        platform: 'desktop',
        deviceId: 'dev-123',
        deviceName: 'My Mac',
        timestamp: now,
      },
    });
  });
});
