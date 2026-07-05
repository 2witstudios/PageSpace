/**
 * Pure decision core for the step-up ceremony — zero DB/network mocking.
 * Every function here takes already-fetched data and returns a verdict, so
 * these tests construct plain objects directly (mirrors
 * `packages/cli/src/auth/loopback-flow.ts`'s pure-core testing style).
 */
import { describe, it, expect } from 'vitest';
import {
  computeActionBindingHash,
  decideStepUpChallenge,
  decideStepUpGrant,
  decideMagicLinkStepUpMetadata,
  parseMagicLinkStepUpNext,
  isStepUpVerdictValid,
} from '../step-up-decisions';

describe('computeActionBindingHash', () => {
  it('is deterministic for the same parts', () => {
    const parts = { clientId: 'abc', scope: 'account' };
    expect(computeActionBindingHash(parts)).toBe(computeActionBindingHash(parts));
  });

  it('is independent of key order', () => {
    expect(computeActionBindingHash({ a: '1', b: '2' })).toBe(computeActionBindingHash({ b: '2', a: '1' }));
  });

  it('produces a different hash when a value changes', () => {
    expect(computeActionBindingHash({ scope: 'account' })).not.toBe(computeActionBindingHash({ scope: 'drive' }));
  });

  it('treats null and undefined the same as an empty string', () => {
    expect(computeActionBindingHash({ state: null })).toBe(computeActionBindingHash({ state: undefined }));
    expect(computeActionBindingHash({ state: null })).toBe(computeActionBindingHash({ state: '' }));
  });

  it('produces a different hash when the key set differs, even with the same values', () => {
    expect(computeActionBindingHash({ a: '1' })).not.toBe(computeActionBindingHash({ b: '1' }));
  });
});

describe('decideStepUpChallenge', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const validBindingHash = computeActionBindingHash({ name: 'My Token' });
  const validChallenge = {
    usedAt: null,
    expiresAt: new Date('2026-01-01T00:02:00Z'),
    metadata: JSON.stringify({ actionBindingHash: validBindingHash }),
  };

  it('rejects a missing challenge as not_found', () => {
    expect(decideStepUpChallenge({ challenge: null, actionBindingHash: validBindingHash, now })).toEqual({
      outcome: 'not_found',
    });
  });

  it('rejects an already-used challenge', () => {
    const challenge = { ...validChallenge, usedAt: new Date('2026-01-01T00:00:30Z') };
    expect(decideStepUpChallenge({ challenge, actionBindingHash: validBindingHash, now })).toEqual({
      outcome: 'already_used',
    });
  });

  it('rejects an expired challenge', () => {
    const challenge = { ...validChallenge, expiresAt: new Date('2025-12-31T23:59:59Z') };
    expect(decideStepUpChallenge({ challenge, actionBindingHash: validBindingHash, now })).toEqual({
      outcome: 'expired',
    });
  });

  it('rejects a challenge bound to a different pending request', () => {
    const otherBindingHash = computeActionBindingHash({ name: 'A different token' });
    expect(decideStepUpChallenge({ challenge: validChallenge, actionBindingHash: otherBindingHash, now })).toEqual({
      outcome: 'binding_mismatch',
    });
  });

  it('rejects a challenge with unparsable metadata', () => {
    const challenge = { ...validChallenge, metadata: 'not-json' };
    expect(decideStepUpChallenge({ challenge, actionBindingHash: validBindingHash, now })).toEqual({
      outcome: 'binding_mismatch',
    });
  });

  it('rejects a challenge with no metadata at all', () => {
    const challenge = { ...validChallenge, metadata: null };
    expect(decideStepUpChallenge({ challenge, actionBindingHash: validBindingHash, now })).toEqual({
      outcome: 'binding_mismatch',
    });
  });

  it('accepts a fresh, unused, correctly-bound challenge', () => {
    expect(decideStepUpChallenge({ challenge: validChallenge, actionBindingHash: validBindingHash, now })).toEqual({
      outcome: 'valid',
    });
  });
});

describe('decideStepUpGrant', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const bindingHash = computeActionBindingHash({ clientId: 'cli-1' });
  const validGrant = {
    userId: 'user-1',
    usedAt: null,
    expiresAt: new Date('2026-01-01T00:03:00Z'),
    metadata: JSON.stringify({ actionBindingHash: bindingHash }),
  };

  it('rejects a missing grant as not_found', () => {
    expect(decideStepUpGrant({ grant: null, userId: 'user-1', actionBindingHash: bindingHash, now })).toEqual({
      outcome: 'not_found',
    });
  });

  it('rejects a grant belonging to a different user as not_found (no oracle)', () => {
    expect(decideStepUpGrant({ grant: validGrant, userId: 'user-2', actionBindingHash: bindingHash, now })).toEqual({
      outcome: 'not_found',
    });
  });

  it('rejects an already-consumed grant', () => {
    const grant = { ...validGrant, usedAt: new Date('2026-01-01T00:00:30Z') };
    expect(decideStepUpGrant({ grant, userId: 'user-1', actionBindingHash: bindingHash, now })).toEqual({
      outcome: 'already_used',
    });
  });

  it('rejects an expired grant', () => {
    const grant = { ...validGrant, expiresAt: new Date('2025-12-31T23:59:59Z') };
    expect(decideStepUpGrant({ grant, userId: 'user-1', actionBindingHash: bindingHash, now })).toEqual({
      outcome: 'expired',
    });
  });

  it('rejects a grant presented against a different pending request', () => {
    const otherBindingHash = computeActionBindingHash({ clientId: 'cli-2' });
    expect(decideStepUpGrant({ grant: validGrant, userId: 'user-1', actionBindingHash: otherBindingHash, now })).toEqual({
      outcome: 'binding_mismatch',
    });
  });

  it('accepts a fresh, unused, correctly-bound, same-user grant', () => {
    expect(decideStepUpGrant({ grant: validGrant, userId: 'user-1', actionBindingHash: bindingHash, now })).toEqual({
      outcome: 'valid',
    });
  });
});

describe('decideMagicLinkStepUpMetadata', () => {
  const bindingHash = computeActionBindingHash({ clientId: 'cli-1' });

  it('rejects a token with no metadata as not_found', () => {
    expect(decideMagicLinkStepUpMetadata(null)).toEqual({ outcome: 'not_found' });
  });

  it('rejects unparsable metadata as not_found', () => {
    expect(decideMagicLinkStepUpMetadata('not-json')).toEqual({ outcome: 'not_found' });
  });

  it('rejects a regular sign-in magic link (wrong purpose) as not_found', () => {
    const metadata = JSON.stringify({ platform: 'desktop', deviceId: 'abc' });
    expect(decideMagicLinkStepUpMetadata(metadata)).toEqual({ outcome: 'not_found' });
  });

  it('rejects step-up metadata missing an actionBindingHash as not_found', () => {
    const metadata = JSON.stringify({ purpose: 'step_up' });
    expect(decideMagicLinkStepUpMetadata(metadata)).toEqual({ outcome: 'not_found' });
  });

  it('extracts the bound actionBindingHash from valid step-up metadata', () => {
    const metadata = JSON.stringify({ purpose: 'step_up', actionBindingHash: bindingHash });
    expect(decideMagicLinkStepUpMetadata(metadata)).toEqual({ outcome: 'valid', actionBindingHash: bindingHash });
  });
});

describe('parseMagicLinkStepUpNext', () => {
  it('returns null when metadata is missing', () => {
    expect(parseMagicLinkStepUpNext(null)).toBeNull();
  });

  it('returns null when metadata has no next field', () => {
    expect(parseMagicLinkStepUpNext(JSON.stringify({ purpose: 'step_up' }))).toBeNull();
  });

  it('returns the next path when present', () => {
    expect(parseMagicLinkStepUpNext(JSON.stringify({ next: '/oauth/consent?client_id=x' }))).toBe(
      '/oauth/consent?client_id=x',
    );
  });
});

describe('isStepUpVerdictValid', () => {
  it('is true only for a valid verdict', () => {
    expect(isStepUpVerdictValid({ outcome: 'valid' })).toBe(true);
    expect(isStepUpVerdictValid({ outcome: 'not_found' })).toBe(false);
    expect(isStepUpVerdictValid({ outcome: 'expired' })).toBe(false);
    expect(isStepUpVerdictValid({ outcome: 'already_used' })).toBe(false);
    expect(isStepUpVerdictValid({ outcome: 'binding_mismatch' })).toBe(false);
  });
});
