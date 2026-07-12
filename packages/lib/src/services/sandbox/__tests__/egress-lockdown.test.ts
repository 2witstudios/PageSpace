import { describe, it } from 'vitest';
import { assert } from './riteway';
import { hashPolicy, hashSandboxEgressPolicy, egressLockdownToken, shouldApplyPolicy } from '../egress-lockdown';
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

describe('egressLockdownToken', () => {
  it('binds the policy to the Sprite INSTANCE', () => {
    assert({
      given: 'the same policy applied to two different Sprite instances',
      should: 'produce different tokens — a replacement VM never inherits its predecessor\'s proof',
      actual:
        egressLockdownToken({ spriteId: 'sprite-A', policyHash: 'h1' }) ===
        egressLockdownToken({ spriteId: 'sprite-B', policyHash: 'h1' }),
      expected: false,
    });
  });

  it('changes when the policy changes on the same instance', () => {
    assert({
      given: 'two policies on one Sprite instance',
      should: 'produce different tokens',
      actual:
        egressLockdownToken({ spriteId: 'sprite-A', policyHash: 'h1' }) ===
        egressLockdownToken({ spriteId: 'sprite-A', policyHash: 'h2' }),
      expected: false,
    });
  });

  it('is undefined when the platform reports no Sprite identity', () => {
    assert({
      given: 'no sprite id (an SDK that stopped reporting it)',
      should: 'produce NO token — an unprovable claim must never be recorded as proof',
      actual: egressLockdownToken({ spriteId: undefined, policyHash: 'h1' }),
      expected: undefined,
    });
  });
});

describe('shouldApplyPolicy', () => {
  const desiredToken = 'sprite-A:h1';

  it('always applies on a fresh create', () => {
    assert({
      given: 'a fresh create',
      should: 'apply the policy (a new Sprite starts with open egress)',
      actual: shouldApplyPolicy({ fresh: true, appliedToken: null, desiredToken }),
      expected: true,
    });
  });

  it('applies on a fresh create even when a matching token is recorded', () => {
    assert({
      given: 'a fresh create whose recorded token happens to match',
      should: 'still apply the policy',
      actual: shouldApplyPolicy({ fresh: true, appliedToken: desiredToken, desiredToken }),
      expected: true,
    });
  });

  it('skips a warm resume of the same VM under the same policy', () => {
    assert({
      given: 'a resume whose recorded token still holds',
      should: 'NOT re-apply (the policy file persists across pause/hibernate)',
      actual: shouldApplyPolicy({ fresh: false, appliedToken: desiredToken, desiredToken }),
      expected: false,
    });
  });

  it('re-applies when the policy changed', () => {
    assert({
      given: 'a resume of the same VM whose desired policy differs',
      should: 'apply the new policy',
      actual: shouldApplyPolicy({ fresh: false, appliedToken: 'sprite-A:h0', desiredToken }),
      expected: true,
    });
  });

  it('re-applies when the VM was replaced under the same name (the concurrent-recreate race)', () => {
    // A concurrent caller re-created the vanished Sprite and has NOT yet reached
    // its own lockdown. We find that new VM by name with fresh === false, and the
    // recorded token names the DEAD one — so we must lock it down ourselves rather
    // than hand back the platform's default open egress.
    assert({
      given: 'a resume whose recorded token names a now-destroyed Sprite instance',
      should: 'apply the policy — a replacement VM is open-egress until locked down',
      actual: shouldApplyPolicy({ fresh: false, appliedToken: 'sprite-DEAD:h1', desiredToken: 'sprite-NEW:h1' }),
      expected: true,
    });
  });

  it('fails closed when the running VM cannot be identified', () => {
    assert({
      given: 'no desired token (the platform reported no Sprite id)',
      should: 'apply the policy — a proof we cannot construct is a proof we do not have',
      actual: shouldApplyPolicy({ fresh: false, appliedToken: 'sprite-A:h1', desiredToken: undefined }),
      expected: true,
    });
  });

  it('fails closed when nothing is recorded', () => {
    assert({
      given: 'a resume with no recorded token (legacy session / lost write)',
      should: 'apply the policy — never hand back unconfirmed egress',
      actual: [
        shouldApplyPolicy({ fresh: false, appliedToken: null, desiredToken }),
        shouldApplyPolicy({ fresh: false, appliedToken: undefined, desiredToken }),
        shouldApplyPolicy({ fresh: false, appliedToken: '', desiredToken }),
      ],
      expected: [true, true, true],
    });
  });
});
