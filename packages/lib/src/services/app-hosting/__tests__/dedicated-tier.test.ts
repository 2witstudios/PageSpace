import { describe, it } from 'vitest';
import { assert } from '../../sandbox/__tests__/riteway';
import {
  DEDICATED_MIN_MACHINES_RUNNING,
  DEDICATED_SUBSCRIPTION_KIND,
  DEFAULT_GUEST_PRESET,
  METERED_MIN_MACHINES_RUNNING,
  PUBLISHED_APP_GUEST_PRESETS,
  applyMinMachinesRunning,
  classifySubscriptionKind,
  dedicatedMonthlyFloorCents,
  findGuestPreset,
  guestPresetShape,
  guestPresetsForTier,
  isCreditMetered,
  isDedicatedEntitled,
  isGuestPresetAllowedForTier,
  isIdleReaperExempt,
  minMachinesRunningFor,
  planTierChange,
} from '../dedicated-tier';

describe('isCreditMetered', () => {
  it('is true for metered and false for dedicated', () => {
    assert({
      given: 'the metered tier',
      should: 'be charged per awake-second against credits',
      actual: isCreditMetered('metered'),
      expected: true,
    });
    assert({
      given: 'the dedicated tier',
      should: 'not be charged per awake-second — it pays a flat monthly price',
      actual: isCreditMetered('dedicated'),
      expected: false,
    });
  });
});

describe('isIdleReaperExempt', () => {
  it('exempts dedicated only', () => {
    assert({
      given: 'a dedicated app',
      should: 'be exempt from the idle reaper — always-on is what was bought',
      actual: isIdleReaperExempt('dedicated'),
      expected: true,
    });
    assert({
      given: 'a metered app',
      should: 'be reapable — scale-to-zero is the metered product',
      actual: isIdleReaperExempt('metered'),
      expected: false,
    });
  });
});

describe('minMachinesRunningFor', () => {
  it('keeps exactly one machine up for dedicated and none for metered', () => {
    assert({
      given: 'a dedicated app',
      should: 'keep one machine running',
      actual: minMachinesRunningFor('dedicated'),
      expected: DEDICATED_MIN_MACHINES_RUNNING,
    });
    assert({
      given: 'a metered app',
      should: 'be allowed to scale to zero',
      actual: minMachinesRunningFor('metered'),
      expected: METERED_MIN_MACHINES_RUNNING,
    });
  });

  it('never scales a dedicated app beyond one machine', () => {
    // Always-on is not replication: the flat price is derived from ONE guest, so a
    // second machine doubles the substrate cost the price was set against.
    assert({
      given: 'the dedicated always-on setting',
      should: 'be exactly one machine',
      actual: DEDICATED_MIN_MACHINES_RUNNING,
      expected: 1,
    });
  });
});

describe('the guest preset catalogue', () => {
  it('lets both tiers run the small v1 guest', () => {
    assert({
      given: 'the default preset on the metered tier',
      should: 'be allowed — it is the v1 unit-economics guardrail',
      actual: isGuestPresetAllowedForTier(DEFAULT_GUEST_PRESET, 'metered'),
      expected: true,
    });
    assert({
      given: 'the default preset on the dedicated tier',
      should: 'be allowed',
      actual: isGuestPresetAllowedForTier(DEFAULT_GUEST_PRESET, 'dedicated'),
      expected: true,
    });
  });

  it('confines the metered tier to the small guest', () => {
    // The awake meter prices every second at ONE fixed shape, so a metered app on
    // a bigger guest is under-billed by exactly the difference — silently.
    const bigger = PUBLISHED_APP_GUEST_PRESETS.filter((p) => p.name !== DEFAULT_GUEST_PRESET);
    assert({
      given: 'every preset larger than the v1 guest',
      should: 'be refused on the metered tier',
      actual: bigger.map((p) => isGuestPresetAllowedForTier(p.name, 'metered')),
      expected: bigger.map(() => false),
    });
    assert({
      given: 'every preset larger than the v1 guest',
      should: 'be allowed on the dedicated tier',
      actual: bigger.map((p) => isGuestPresetAllowedForTier(p.name, 'dedicated')),
      expected: bigger.map(() => true),
    });
  });

  it('refuses an unknown preset rather than defaulting it in', () => {
    assert({
      given: 'a preset that is not in the catalogue',
      should: 'be refused on the dedicated tier',
      actual: isGuestPresetAllowedForTier('shared-cpu-64x-262144', 'dedicated'),
      expected: false,
    });
    assert({
      given: 'a preset that is not in the catalogue',
      should: 'have no shape to price',
      actual: guestPresetShape('shared-cpu-64x-262144'),
      expected: null,
    });
    assert({
      given: 'a preset that is not in the catalogue',
      should: 'not be found',
      actual: findGuestPreset('shared-cpu-64x-262144'),
      expected: null,
    });
  });

  it('offers the dedicated tier every size and the metered tier only one', () => {
    assert({
      given: 'the metered tier',
      should: 'offer exactly the v1 guest',
      actual: guestPresetsForTier('metered').map((p) => p.name),
      expected: [DEFAULT_GUEST_PRESET],
    });
    assert({
      given: 'the dedicated tier',
      should: 'offer the whole catalogue',
      actual: guestPresetsForTier('dedicated').map((p) => p.name),
      expected: PUBLISHED_APP_GUEST_PRESETS.map((p) => p.name),
    });
  });
});

describe('dedicatedMonthlyFloorCents', () => {
  it('prices a bigger guest above a smaller one', () => {
    const small = dedicatedMonthlyFloorCents('shared-cpu-1x-512');
    const large = dedicatedMonthlyFloorCents('shared-cpu-4x-4096');
    assert({
      given: 'a 4x/4GB guest against a 1x/512MB guest',
      should: 'have a strictly higher monthly floor',
      actual: large > small,
      expected: true,
    });
  });

  it('is derived from the rate table x 730 hours x the 1.5x machine markup', () => {
    // Pinned against the arithmetic rather than a magic number so a change to
    // MACHINE_RATES or MACHINE_MARKUP_BPS moves the expectation with the code.
    const hourly = 1 * 0.07 + 0.5 * 0.04375;
    const expected = Math.ceil(hourly * 730 * 100 * 1.5);
    assert({
      given: 'the v1 small guest at the published Sprites rates',
      should: 'floor at 1.5x its monthly substrate cost',
      actual: dedicatedMonthlyFloorCents('shared-cpu-1x-512'),
      expected,
    });
  });

  it('has no opinion about a shape it cannot price', () => {
    assert({
      given: 'a preset outside the catalogue',
      should: 'yield no floor rather than an invented one',
      actual: dedicatedMonthlyFloorCents('shared-cpu-64x-262144'),
      expected: 0,
    });
  });
});

describe('classifySubscriptionKind', () => {
  it('treats a subscription with no kind as an account plan', () => {
    // FAIL CLOSED MEANS THE OLD BEHAVIOUR: every subscription written before this
    // discriminator existed carries no metadata and must keep its existing path.
    assert({
      given: 'no metadata at all',
      should: 'be an account plan',
      actual: classifySubscriptionKind(undefined),
      expected: 'account_plan',
    });
    assert({
      given: 'null metadata',
      should: 'be an account plan',
      actual: classifySubscriptionKind(null),
      expected: 'account_plan',
    });
    assert({
      given: 'metadata with other keys but no kind',
      should: 'be an account plan',
      actual: classifySubscriptionKind({ userId: 'user_1' }),
      expected: 'account_plan',
    });
    assert({
      given: 'an empty-string kind',
      should: 'be an account plan rather than an unrecognised value',
      actual: classifySubscriptionKind({ kind: '' }),
      expected: 'account_plan',
    });
  });

  it('recognises the dedicated hosting kind exactly', () => {
    assert({
      given: 'the dedicated hosting kind',
      should: 'route to the hosting handler',
      actual: classifySubscriptionKind({ kind: DEDICATED_SUBSCRIPTION_KIND }),
      expected: 'published_app_dedicated',
    });
  });

  it('reports an unrecognised kind instead of guessing at it', () => {
    // Distinguished from `account_plan` only so the caller can LOG it; both take
    // the account path, because dropping the event would silently stop
    // maintaining a real customer's tier.
    assert({
      given: 'a kind this code has never been taught',
      should: 'be reported as unknown',
      actual: classifySubscriptionKind({ kind: 'published_app_dedicated_v2' }),
      expected: 'unknown',
    });
    assert({
      given: 'a near-miss on the dedicated kind',
      should: 'not be treated as dedicated',
      actual: classifySubscriptionKind({ kind: 'PUBLISHED_APP_DEDICATED' }),
      expected: 'unknown',
    });
  });
});

describe('isDedicatedEntitled', () => {
  it('entitles a paying subscription', () => {
    assert({
      given: 'the paying statuses',
      should: 'entitle the app to stay always-on',
      actual: ['active', 'trialing'].map(isDedicatedEntitled),
      expected: [true, true],
    });
  });

  it('keeps a past_due app up while Stripe retries', () => {
    // Taking a customer's PRODUCTION app to scale-to-zero over a card that will
    // probably work on the next attempt is an outage they did not cause. The free
    // ride is bounded by Stripe's dunning ending at canceled/unpaid.
    assert({
      given: 'a past_due subscription mid-dunning',
      should: 'still entitle the app',
      actual: isDedicatedEntitled('past_due'),
      expected: true,
    });
  });

  it('does not entitle a subscription that was never paid for', () => {
    // Otherwise an always-on machine is available to anyone who starts a checkout
    // and abandons it.
    assert({
      given: 'an incomplete subscription',
      should: 'not entitle the app',
      actual: isDedicatedEntitled('incomplete'),
      expected: false,
    });
  });

  it('does not entitle a subscription that has stopped paying', () => {
    assert({
      given: 'terminal non-paying statuses',
      should: 'not entitle the app',
      actual: ['canceled', 'unpaid', 'incomplete', 'incomplete_expired'].map(isDedicatedEntitled),
      expected: [false, false, false, false],
    });
  });
});

describe('planTierChange', () => {
  it('un-parks an upgrade, because the database cannot represent a parked dedicated row', () => {
    const plan = planTierChange({
      from: 'metered',
      to: 'dedicated',
      status: 'parked',
      guestPreset: DEFAULT_GUEST_PRESET,
    });
    assert({
      given: 'an out-of-credits parked app being upgraded',
      should: 'move to stopped in the same write — parked is metered-only',
      actual: plan,
      expected: { allowed: true, tier: 'dedicated', unpark: true, nextStatus: 'stopped' },
    });
  });

  it('un-parks to stopped rather than running — un-parking is not waking', () => {
    const plan = planTierChange({
      from: 'metered',
      to: 'dedicated',
      status: 'parked',
      guestPreset: DEFAULT_GUEST_PRESET,
    });
    assert({
      given: 'an upgrade from parked',
      should: 'leave the app to resume through the ordinary wake path',
      actual: plan.allowed === true ? plan.nextStatus : null,
      expected: 'stopped',
    });
  });

  it('leaves a non-parked status alone', () => {
    const plan = planTierChange({
      from: 'metered',
      to: 'dedicated',
      status: 'running',
      guestPreset: DEFAULT_GUEST_PRESET,
    });
    assert({
      given: 'a running app being upgraded',
      should: 'change the tier without touching the status',
      actual: plan,
      expected: { allowed: true, tier: 'dedicated', unpark: false, nextStatus: 'running' },
    });
  });

  it('refuses a downgrade that would strand the app on an unmeterable guest', () => {
    const plan = planTierChange({
      from: 'dedicated',
      to: 'metered',
      status: 'running',
      guestPreset: 'shared-cpu-4x-4096',
    });
    assert({
      given: 'a dedicated app on a big guest being downgraded',
      should: 'refuse rather than silently resize a serving machine',
      actual: plan,
      expected: { allowed: false, reason: 'guest_preset_not_allowed' },
    });
  });

  it('allows a downgrade that is already on the metered-legal guest', () => {
    const plan = planTierChange({
      from: 'dedicated',
      to: 'metered',
      status: 'running',
      guestPreset: DEFAULT_GUEST_PRESET,
    });
    assert({
      given: 'a dedicated app already on the small guest',
      should: 'downgrade cleanly',
      actual: plan,
      expected: { allowed: true, tier: 'metered', unpark: false, nextStatus: 'running' },
    });
  });

  it('refuses a no-op and a terminal row', () => {
    assert({
      given: 'a tier change to the tier the app is already on',
      should: 'be refused as a no-op',
      actual: planTierChange({ from: 'metered', to: 'metered', status: 'running', guestPreset: DEFAULT_GUEST_PRESET }),
      expected: { allowed: false, reason: 'same_tier' },
    });
    assert({
      given: 'an app being torn down',
      should: 'refuse a tier change — the row is about to be deleted',
      actual: planTierChange({ from: 'metered', to: 'dedicated', status: 'destroying', guestPreset: DEFAULT_GUEST_PRESET }),
      expected: { allowed: false, reason: 'terminal_status' },
    });
    assert({
      given: 'a failed app',
      should: 'refuse a tier change — it re-enters only through an explicit retry',
      actual: planTierChange({ from: 'metered', to: 'dedicated', status: 'failed', guestPreset: DEFAULT_GUEST_PRESET }),
      expected: { allowed: false, reason: 'terminal_status' },
    });
  });
});

describe('applyMinMachinesRunning', () => {
  it('preserves every field Fly gave us, including ones this repo has never heard of', () => {
    // Fly's machine update is a FULL REPLACE: any field dropped here is deleted
    // from the live machine with a 200 OK and no warning.
    const current = {
      image: 'registry.fly.io/pgs-app-x@sha256:abc',
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
      env: { PORT: '8080' },
      mounts: [{ volume: 'vol_1' }],
      checks: { http: { type: 'http' } },
      metadata: { pagespace_published_app_id: 'app_1' },
      some_future_fly_field: { we: 'have never heard of this' },
      services: [{ protocol: 'tcp', internal_port: 8080, min_machines_running: 0 }],
    };
    const merged = applyMinMachinesRunning(current, 1);
    assert({
      given: 'a live config with unknown keys',
      should: 'return every key untouched except min_machines_running',
      actual: { ...merged.config, services: undefined },
      expected: { ...current, services: undefined },
    });
    assert({
      given: 'a service carrying the old setting',
      should: 'carry the new one and keep its other fields',
      actual: merged.config.services,
      expected: [{ protocol: 'tcp', internal_port: 8080, min_machines_running: 1 }],
    });
    assert({
      given: 'one rewritten service',
      should: 'be counted',
      actual: merged.applied,
      expected: 1,
    });
  });

  it('does not mutate the config it was handed', () => {
    const current = { services: [{ internal_port: 8080, min_machines_running: 0 }] };
    applyMinMachinesRunning(current, 1);
    assert({
      given: 'the caller’s original config',
      should: 'be left exactly as it was',
      actual: current.services[0].min_machines_running,
      expected: 0,
    });
  });

  it('invents nothing for a config with no services', () => {
    // Fabricating a service would tell Fly to start routing traffic to a port
    // this function has no way to know.
    const merged = applyMinMachinesRunning({ image: 'x' }, 1);
    assert({
      given: 'a config with no services key',
      should: 'come back unchanged',
      actual: merged.config,
      expected: { image: 'x' },
    });
    assert({
      given: 'a config with no services key',
      should: 'report that nothing was applied',
      actual: merged.applied,
      expected: 0,
    });
  });

  it('passes an entry it does not understand through untouched and uncounted', () => {
    const merged = applyMinMachinesRunning({ services: ['weird', null, { internal_port: 8080 }] }, 1);
    assert({
      given: 'a services array with entries that are not objects',
      should: 'return them exactly as received and rewrite only the real one',
      actual: merged.config.services,
      expected: ['weird', null, { internal_port: 8080, min_machines_running: 1 }],
    });
    assert({
      given: 'entries that could not carry the setting',
      should: 'not be counted as applied',
      actual: merged.applied,
      expected: 1,
    });
  });
});
