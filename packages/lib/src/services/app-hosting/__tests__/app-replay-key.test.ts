/**
 * The per-app fly-replay `state` key.
 *
 * The property that matters: a key that authenticates traffic to app A must not
 * authenticate traffic to app B, and neither must be derivable from the app name
 * alone (which is not secret — it is in our logs and Fly's). Everything else here
 * guards the ways a derivation like this usually fails: a weak secret accepted
 * silently, an ambiguous fold, or a bearer comparison that leaks a prefix.
 */
import { describe, expect, it } from 'vitest';
import { derivePublishedAppReplayKey, verifyPublishedAppReplayKey } from '../app-replay-key';
import { assert } from '../../../__tests__/riteway';

const SECRET = 'x'.repeat(32);
const OTHER_SECRET = 'y'.repeat(32);

const key = (flyAppName: string, secret = SECRET) =>
  derivePublishedAppReplayKey({ flyAppName, secret });

describe('derivePublishedAppReplayKey — deterministic, per app, per secret', () => {
  // The two derivations are bound to separate names on purpose: comparing the
  // call expression against itself reads as a self-comparison to the linter,
  // and the property under test is that two SEPARATE derivations agree.
  const firstDerivation = key('pgs-app-abc');
  const secondDerivation = key('pgs-app-abc');

  assert({
    given: 'the same app name and secret twice',
    should: 'derive the same key, so the router and the guest agree without exchanging anything',
    actual: firstDerivation === secondDerivation,
    expected: true,
  });

  assert({
    given: 'two different apps under one secret',
    should: 'derive different keys, so a leaked key cannot authenticate a sibling app',
    actual: key('pgs-app-abc') === key('pgs-app-def'),
    expected: false,
  });

  assert({
    given: 'one app under two different secrets',
    should: 'derive different keys, so rotating the secret invalidates the old key',
    actual: key('pgs-app-abc') === key('pgs-app-abc', OTHER_SECRET),
    expected: false,
  });

  assert({
    given: 'any app name',
    should: 'be hex, so the value cannot carry the fly-replay header grammar',
    actual: /^[0-9a-f]{64}$/.test(key('pgs-app-abc')),
    expected: true,
  });
});

describe('derivePublishedAppReplayKey — fails closed on weak or ambiguous input', () => {
  it.each([
    ['unset', ''],
    ['31 characters — one short of the floor', 'x'.repeat(31)],
  ])('given a %s secret, should throw rather than derive from weak material', (_label, secret) => {
    expect(() => key('pgs-app-abc', secret)).toThrow(/at least 32/);
  });

  it('given a secret exactly at the floor, should derive', () => {
    expect(() => key('pgs-app-abc', 'x'.repeat(32))).not.toThrow();
  });

  it('given an empty app name, should throw', () => {
    expect(() => key('')).toThrow();
  });

  it('given an app name carrying the NUL delimiter, should throw rather than fold ambiguously', () => {
    expect(() => key('pgs-app\0evil')).toThrow(/NUL/);
  });
});

describe('verifyPublishedAppReplayKey — the guest side of the contract', () => {
  assert({
    given: 'the key this app derives',
    should: 'accept it',
    actual: verifyPublishedAppReplayKey(key('pgs-app-abc'), {
      flyAppName: 'pgs-app-abc',
      secret: SECRET,
    }),
    expected: true,
  });

  assert({
    given: "a SIBLING app's key",
    should: 'reject it — this is the property the per-app derivation exists for',
    actual: verifyPublishedAppReplayKey(key('pgs-app-def'), {
      flyAppName: 'pgs-app-abc',
      secret: SECRET,
    }),
    expected: false,
  });

  assert({
    given: 'a key derived under a rotated-away secret',
    should: 'reject it',
    actual: verifyPublishedAppReplayKey(key('pgs-app-abc', OTHER_SECRET), {
      flyAppName: 'pgs-app-abc',
      secret: SECRET,
    }),
    expected: false,
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
  ])('given a %s presented value, should answer false', (_label, presented) => {
    expect(
      verifyPublishedAppReplayKey(presented, { flyAppName: 'pgs-app-abc', secret: SECRET }),
    ).toBe(false);
  });

  assert({
    given: 'a malformed secret on the GUEST side',
    should: 'answer false rather than throw — a throw at this boundary becomes a fail-open catch',
    actual: verifyPublishedAppReplayKey('anything', { flyAppName: 'pgs-app-abc', secret: 'short' }),
    expected: false,
  });

  assert({
    given: 'a correct key with one character changed',
    should: 'reject it',
    actual: verifyPublishedAppReplayKey(`0${key('pgs-app-abc').slice(1)}`, {
      flyAppName: 'pgs-app-abc',
      secret: SECRET,
    }),
    expected: false,
  });

  assert({
    given: 'a correct PREFIX of the key',
    should: 'reject it, so the comparison is not a prefix oracle',
    actual: verifyPublishedAppReplayKey(key('pgs-app-abc').slice(0, 32), {
      flyAppName: 'pgs-app-abc',
      secret: SECRET,
    }),
    expected: false,
  });
});
