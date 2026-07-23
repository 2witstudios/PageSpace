import { describe, it } from 'vitest';
import { assert } from '@/lib/ai/tools/__tests__/riteway';

import { resolveGenerationAdmission } from '../generation-admission';

/** `glm` is the sole ADMIN_ONLY_PROVIDERS member; the rest of the catalog is role-free. */
const ADMIN_ONLY = 'glm';
const ORDINARY = 'openai';

const never = () => false;
const always = () => true;

describe('resolveGenerationAdmission', () => {
  it('given an ordinary provider and an in-tier model, should allow', () => {
    assert({
      given: 'a free user on a free-tier model',
      should: 'allow the generation',
      actual: resolveGenerationAdmission({
        provider: ORDINARY,
        model: 'openai/gpt-5.4-mini',
        subscriptionTier: 'free',
        isAdmin: false,
        requiresProSubscription: never,
      }),
      expected: { allowed: true },
    });
  });

  it('given an admin-only provider and a non-admin, should deny on ROLE — not as a subscription problem', () => {
    assert({
      given: 'a paying non-admin user on an admin-only provider',
      should: 'deny with the role reason, which no upgrade lifts',
      actual: resolveGenerationAdmission({
        provider: ADMIN_ONLY,
        model: 'glm-4',
        subscriptionTier: 'pro',
        isAdmin: false,
        requiresProSubscription: never,
      }),
      expected: { allowed: false, reason: 'provider_admin_only' },
    });
  });

  it('given an admin-only provider and an admin, should allow', () => {
    assert({
      given: 'an admin on an admin-only provider',
      should: 'allow the generation',
      actual: resolveGenerationAdmission({
        provider: ADMIN_ONLY,
        model: 'glm-4',
        subscriptionTier: 'free',
        isAdmin: true,
        requiresProSubscription: never,
      }),
      expected: { allowed: true },
    });
  });

  it('given an out-of-tier model, should deny with the upgradeable reason', () => {
    assert({
      given: 'a free user on a paid-tier model',
      should: 'deny with the subscription reason',
      actual: resolveGenerationAdmission({
        provider: ORDINARY,
        model: 'anthropic/claude-opus-4.8',
        subscriptionTier: 'free',
        isAdmin: false,
        requiresProSubscription: always,
      }),
      expected: { allowed: false, reason: 'subscription_required' },
    });
  });

  it('given BOTH gates failing, should report the ROLE denial — the one an upgrade cannot fix', () => {
    assert({
      given: 'a free non-admin user on an admin-only provider with an out-of-tier model',
      should: 'deny on role rather than send them to a checkout that would not help',
      actual: resolveGenerationAdmission({
        provider: ADMIN_ONLY,
        model: 'glm-4',
        subscriptionTier: 'free',
        isAdmin: false,
        requiresProSubscription: always,
      }),
      expected: { allowed: false, reason: 'provider_admin_only' },
    });
  });

  it('given no model at all, should defer entirely to the tier predicate', () => {
    assert({
      given: 'an unset model',
      should: 'allow when the tier predicate allows it',
      actual: resolveGenerationAdmission({
        provider: ORDINARY,
        model: undefined,
        subscriptionTier: 'free',
        isAdmin: false,
        requiresProSubscription: never,
      }),
      expected: { allowed: true },
    });
  });
});
