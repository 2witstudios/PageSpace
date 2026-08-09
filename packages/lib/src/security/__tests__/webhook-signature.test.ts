import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  v0Scheme,
  DEFAULT_REPLAY_WINDOW_MS,
  type SignatureScheme,
} from '../webhook-signature';

const SECRET = 'test-webhook-secret';
const BODY = JSON.stringify({ content: 'deploy finished' });

// A fixed "now" so every case is deterministic — the module itself never reads a clock.
const NOW_MS = 1_752_900_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

function verifyAt(overrides: Partial<Parameters<SignatureScheme['verify']>[0]> = {}) {
  const timestamp = String(NOW_SECONDS);
  return v0Scheme.verify({
    secret: SECRET,
    signature: v0Scheme.sign(SECRET, NOW_SECONDS, BODY),
    timestamp,
    rawBody: BODY,
    nowMs: NOW_MS,
    replayWindowMs: DEFAULT_REPLAY_WINDOW_MS,
    ...overrides,
  });
}

describe('v0Scheme.sign', () => {
  it('produces v0=hex(HMAC-SHA256(secret, "v0:{timestamp}:{rawBody}"))', () => {
    const expected =
      'v0=' + createHmac('sha256', SECRET).update(`v0:${NOW_SECONDS}:${BODY}`).digest('hex');
    expect(v0Scheme.sign(SECRET, NOW_SECONDS, BODY)).toBe(expected);
  });

  it('is deterministic for identical inputs and differs when any input changes', () => {
    const base = v0Scheme.sign(SECRET, NOW_SECONDS, BODY);
    expect(v0Scheme.sign(SECRET, NOW_SECONDS, BODY)).toBe(base);
    expect(v0Scheme.sign('other-secret', NOW_SECONDS, BODY)).not.toBe(base);
    expect(v0Scheme.sign(SECRET, NOW_SECONDS + 1, BODY)).not.toBe(base);
    expect(v0Scheme.sign(SECRET, NOW_SECONDS, BODY + 'x')).not.toBe(base);
  });
});

describe('v0Scheme.verify', () => {
  it('accepts a valid sign → verify roundtrip', () => {
    expect(verifyAt()).toBe(true);
  });

  it('rejects a signature produced with the wrong secret', () => {
    expect(verifyAt({ signature: v0Scheme.sign('wrong-secret', NOW_SECONDS, BODY) })).toBe(false);
  });

  it('rejects a stale timestamp outside the replay window', () => {
    const stale = NOW_SECONDS - 6 * 60;
    expect(
      verifyAt({
        signature: v0Scheme.sign(SECRET, stale, BODY),
        timestamp: String(stale),
      }),
    ).toBe(false);
  });

  it('rejects a future timestamp outside the replay window', () => {
    const future = NOW_SECONDS + 6 * 60;
    expect(
      verifyAt({
        signature: v0Scheme.sign(SECRET, future, BODY),
        timestamp: String(future),
      }),
    ).toBe(false);
  });

  it('accepts a timestamp exactly at the replay-window boundary', () => {
    const edge = NOW_SECONDS - DEFAULT_REPLAY_WINDOW_MS / 1000;
    expect(
      verifyAt({
        signature: v0Scheme.sign(SECRET, edge, BODY),
        timestamp: String(edge),
      }),
    ).toBe(true);
  });

  it('rejects a signature computed over a different body than the one delivered (tampered body)', () => {
    expect(
      verifyAt({ signature: v0Scheme.sign(SECRET, NOW_SECONDS, JSON.stringify({ content: 'other' })) }),
    ).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyAt({ signature: null })).toBe(false);
    expect(verifyAt({ signature: '' })).toBe(false);
  });

  it('rejects a missing timestamp', () => {
    expect(verifyAt({ timestamp: null })).toBe(false);
    expect(verifyAt({ timestamp: '' })).toBe(false);
  });

  it('rejects a malformed signature that is not in v0=hex form', () => {
    expect(verifyAt({ signature: 'not-a-signature' })).toBe(false);
    expect(verifyAt({ signature: 'v0=' })).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    for (const bad of ['not-a-number', 'NaN', 'Infinity', '-Infinity', '12abc']) {
      expect(verifyAt({ timestamp: bad })).toBe(false);
    }
  });

  it('verifies against the raw header string, so a re-encoded timestamp ("0" + digits) fails', () => {
    // The sender signs the exact header bytes; verify must recompute over the
    // header string as delivered, not a normalized number.
    const padded = '0' + String(NOW_SECONDS);
    expect(verifyAt({ timestamp: padded })).toBe(false);
  });
});

describe('scheme pluggability', () => {
  it('exposes a stable scheme name for registry keying', () => {
    expect(v0Scheme.name).toBe('v0');
  });

  it('accepts any SignatureScheme-shaped adapter — a provider scheme slots in without intake rework', () => {
    // Compile-time seam check: a GitHub-style adapter is just another object
    // implementing the same interface. It must typecheck and be callable
    // through the same shape the intake uses.
    const fakeGithubStyle: SignatureScheme = {
      name: 'sha256',
      sign: (secret, _timestampSeconds, rawBody) =>
        'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'),
      verify: ({ secret, signature, rawBody }) =>
        signature === 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'),
    };
    const sig = fakeGithubStyle.sign(SECRET, NOW_SECONDS, BODY);
    expect(
      fakeGithubStyle.verify({
        secret: SECRET,
        signature: sig,
        timestamp: null,
        rawBody: BODY,
        nowMs: NOW_MS,
        replayWindowMs: DEFAULT_REPLAY_WINDOW_MS,
      }),
    ).toBe(true);
  });
});

describe('webhook-signature purity', () => {
  it('imports no db client, fetch, env, or clock — current time arrives as a parameter', () => {
    const src = readFileSync(fileURLToPath(new URL('../webhook-signature.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/from ['"][^'"]*\/db['"]/);
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/new Date\(/);
    // Only type-only imports are allowed from schema modules (erased at compile time).
    const schemaImports = src.match(/^import .*from ['"][^'"]*\/schema\/[^'"]*['"];?$/gm) ?? [];
    for (const line of schemaImports) {
      expect(line.startsWith('import type')).toBe(true);
    }
  });
});
