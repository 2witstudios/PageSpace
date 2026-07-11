import { describe, it } from 'vitest';
import { assert } from './riteway';
import { hashPolicy, hashSandboxEgressPolicy, shouldApplyPolicy } from '../egress-lockdown';
import { buildSpriteNetworkPolicy } from '../egress';

describe('hashPolicy', () => {
  it('is stable for the same policy', () => {
    assert({
      given: 'the same policy built twice',
      should: 'produce the same hash',
      actual:
        hashPolicy(buildSpriteNetworkPolicy({ egressAllowlist: ['github.com'] })) ===
        hashPolicy(buildSpriteNetworkPolicy({ egressAllowlist: ['github.com'] })),
      expected: true,
    });
  });

  it('is canonical across key order and rule order', () => {
    assert({
      given: 'the same rules with different key order and array order',
      should: 'produce the same hash (precedence is by specificity, not position)',
      actual:
        hashPolicy({ rules: [{ domain: 'a.com', action: 'allow' }, { domain: '*', action: 'deny' }] }) ===
        hashPolicy({ rules: [{ action: 'deny', domain: '*' }, { action: 'allow', domain: 'a.com' }] }),
      expected: true,
    });
  });

  it('distinguishes different rule sets', () => {
    assert({
      given: 'an allow rule swapped for a deny rule',
      should: 'produce a different hash',
      actual:
        hashPolicy({ rules: [{ domain: 'a.com', action: 'allow' }] }) ===
        hashPolicy({ rules: [{ domain: 'a.com', action: 'deny' }] }),
      expected: false,
    });
  });
});

describe('hashSandboxEgressPolicy', () => {
  it('changes when the egress mode changes', () => {
    assert({
      given: 'open egress vs allowlist egress',
      should: 'produce different hashes',
      actual:
        hashSandboxEgressPolicy({ egressMode: 'open' }) === hashSandboxEgressPolicy({ egressMode: 'allowlist' }),
      expected: false,
    });
  });

  it('changes when the allowlist changes', () => {
    assert({
      given: 'a widened allowlist',
      should: 'produce a different hash',
      actual:
        hashSandboxEgressPolicy({ egressAllowlist: ['github.com'] }) ===
        hashSandboxEgressPolicy({ egressAllowlist: ['github.com', 'npmjs.org'] }),
      expected: false,
    });
  });

  it('hashes the built policy, not the raw options', () => {
    assert({
      given: 'allowlist entries that sanitize to the same host',
      should: 'produce the same hash (no needless re-apply)',
      actual:
        hashSandboxEgressPolicy({ egressAllowlist: ['GitHub.com'] }) ===
        hashSandboxEgressPolicy({ egressAllowlist: [' github.com '] }),
      expected: true,
    });
  });
});

describe('shouldApplyPolicy', () => {
  const desiredPolicyHash = 'desired-hash';

  it('always applies on a fresh create', () => {
    assert({
      given: 'a fresh create',
      should: 'apply the policy (a new Sprite starts with open egress)',
      actual: shouldApplyPolicy({ fresh: true, appliedPolicyHash: null, desiredPolicyHash }),
      expected: true,
    });
  });

  it('applies on a fresh create even when a matching hash is recorded', () => {
    assert({
      given: 'a fresh create whose recorded hash happens to match (recycled name)',
      should: 'still apply the policy',
      actual: shouldApplyPolicy({ fresh: true, appliedPolicyHash: desiredPolicyHash, desiredPolicyHash }),
      expected: true,
    });
  });

  it('skips a resume whose recorded policy matches', () => {
    assert({
      given: 'a resume whose recorded applied hash matches the desired policy',
      should: 'NOT re-apply (the policy file persists across pause/hibernate)',
      actual: shouldApplyPolicy({ fresh: false, appliedPolicyHash: desiredPolicyHash, desiredPolicyHash }),
      expected: false,
    });
  });

  it('re-applies on a hash mismatch', () => {
    assert({
      given: 'a resume whose recorded applied hash differs (policy changed)',
      should: 'apply the new policy',
      actual: shouldApplyPolicy({ fresh: false, appliedPolicyHash: 'stale-hash', desiredPolicyHash }),
      expected: true,
    });
  });

  it('fails closed when the applied policy is unknown', () => {
    assert({
      given: 'a resume with no recorded applied hash (legacy session / lost write)',
      should: 'apply the policy — never hand back unconfirmed egress',
      actual: [
        shouldApplyPolicy({ fresh: false, appliedPolicyHash: null, desiredPolicyHash }),
        shouldApplyPolicy({ fresh: false, appliedPolicyHash: undefined, desiredPolicyHash }),
        shouldApplyPolicy({ fresh: false, appliedPolicyHash: '', desiredPolicyHash }),
      ],
      expected: [true, true, true],
    });
  });
});
