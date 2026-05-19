import crypto from 'crypto';

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

function timingSafeEqual(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export function verifyZoomWebhookSignature(
  signature: string | null,
  timestamp: string | null,
  rawBody: string,
  secretToken: string
): boolean {
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (isNaN(ts) || Math.abs(Date.now() - ts * 1000) > REPLAY_WINDOW_MS) return false;

  const message = `v0:${timestamp}:${rawBody}`;
  const expected = 'v0=' + crypto.createHmac('sha256', secretToken).update(message).digest('hex');

  return timingSafeEqual(signature, expected);
}

export function handleUrlValidationChallenge(
  plainToken: string,
  secretToken: string
): { plainToken: string; encryptedToken: string } {
  const encryptedToken = crypto
    .createHmac('sha256', secretToken)
    .update(plainToken)
    .digest('hex');
  return { plainToken, encryptedToken };
}
