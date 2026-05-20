import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { verifyZoomWebhookSignature, handleUrlValidationChallenge } from '../verify-webhook';

const SECRET = 'test-zoom-webhook-secret';

function makeSignature(timestamp: string, body: string, secret = SECRET): string {
  const message = `v0:${timestamp}:${body}`;
  const hash = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return `v0=${hash}`;
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('verifyZoomWebhookSignature', () => {
  it('given a valid signature and fresh timestamp, should return true', () => {
    const ts = nowSeconds();
    const body = '{"event":"recording.transcript_completed"}';
    const sig = makeSignature(ts, body);

    expect(verifyZoomWebhookSignature(sig, ts, body, SECRET)).toBe(true);
  });

  it('given a tampered body, should return false', () => {
    const ts = nowSeconds();
    const body = '{"event":"recording.transcript_completed"}';
    const sig = makeSignature(ts, body);

    expect(verifyZoomWebhookSignature(sig, ts, '{"event":"tampered"}', SECRET)).toBe(false);
  });

  it('given a wrong secret, should return false', () => {
    const ts = nowSeconds();
    const body = '{"event":"recording.transcript_completed"}';
    const sig = makeSignature(ts, body, 'wrong-secret');

    expect(verifyZoomWebhookSignature(sig, ts, body, SECRET)).toBe(false);
  });

  it('given a null signature, should return false', () => {
    const ts = nowSeconds();
    const body = 'body';

    expect(verifyZoomWebhookSignature(null, ts, body, SECRET)).toBe(false);
  });

  it('given a null timestamp, should return false', () => {
    const body = 'body';
    const sig = makeSignature(nowSeconds(), body);

    expect(verifyZoomWebhookSignature(sig, null, body, SECRET)).toBe(false);
  });

  it('given a timestamp older than 5 minutes, should return false', () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const body = 'body';
    const sig = makeSignature(staleTs, body);

    expect(verifyZoomWebhookSignature(sig, staleTs, body, SECRET)).toBe(false);
  });

  it('given a timestamp in the future beyond 5 minutes, should return false', () => {
    const futureTs = String(Math.floor(Date.now() / 1000) + 6 * 60);
    const body = 'body';
    const sig = makeSignature(futureTs, body);

    expect(verifyZoomWebhookSignature(sig, futureTs, body, SECRET)).toBe(false);
  });

  it('given a non-numeric timestamp, should return false', () => {
    const body = 'body';
    const sig = makeSignature('not-a-number', body);

    expect(verifyZoomWebhookSignature(sig, 'not-a-number', body, SECRET)).toBe(false);
  });
});

describe('handleUrlValidationChallenge', () => {
  it('should echo the plainToken and return a correct HMAC-SHA256 encryptedToken', () => {
    const plainToken = 'abc123xyz';
    const result = handleUrlValidationChallenge(plainToken, SECRET);

    const expected = crypto.createHmac('sha256', SECRET).update(plainToken).digest('hex');

    expect(result.plainToken).toBe(plainToken);
    expect(result.encryptedToken).toBe(expected);
  });

  it('given different secrets, should produce different encryptedTokens', () => {
    const plainToken = 'same-token';
    const r1 = handleUrlValidationChallenge(plainToken, 'secret-a');
    const r2 = handleUrlValidationChallenge(plainToken, 'secret-b');

    expect(r1.encryptedToken).not.toBe(r2.encryptedToken);
  });
});
