import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  accountOf,
  creditsOf,
  describeAccountRow,
  driveCountOf,
  glanceRows,
  overviewGroups,
  planNameOf,
} from './account-overview-model';
import { accountNav, type NavContext } from '../settings-nav/settings-nav';

const cloud: NavContext = { isDesktop: false, showBilling: true, isNative: false, onPrem: false, hasOrganizations: false };

describe('accountOf()', () => {
  test('the viewer identity from GET /api/account', () => {
    assert({
      given: 'the account body, and an error body',
      should: 'read name, email and image, and reject anything else',
      actual: [
        accountOf({ id: 'u1', name: 'Jono', email: 'jono@example.com', image: null }),
        accountOf({ error: 'nope' }),
        accountOf(null),
      ],
      expected: [
        { name: 'Jono', email: 'jono@example.com', image: null },
        { name: '', email: null, image: null },
        null,
      ],
    });
  });
});

describe('planNameOf() and creditsOf() and driveCountOf()', () => {
  test('the figures read from their routes, whole numbers only', () => {
    assert({
      given: 'a subscription status, a credit balance and a drive list',
      should: 'name the tier, floor the credits and count the drives',
      actual: [
        planNameOf({ subscriptionTier: 'pro' }),
        planNameOf({ subscriptionTier: 'unknown-tier' }),
        creditsOf({ spendable: 612.9, monthly: { remaining: 600 } }),
        creditsOf({ billingEnabled: false }),
        driveCountOf([{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }]),
        driveCountOf({ error: 'nope' }),
      ],
      expected: ['Pro', 'Free', 612, null, 3, null],
    });
  });
});

describe('glanceRows()', () => {
  const loaded = {
    status: { subscriptionTier: 'pro' },
    credits: { spendable: 612 },
    drives: [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }],
  };

  test('billing on: Plan, credits and drives', () => {
    assert({
      given: 'cloud billing and every route answered',
      should: 'show Plan, Your credits as a whole number, and Drives',
      actual: glanceRows({ billing: true, ...loaded }).map((row) => [row.label, row.value]),
      expected: [
        ['Plan', 'Pro'],
        ['Your credits', '612 credits'],
        ['Drives', '3'],
      ],
    });
  });

  test('billing off (tenant, onprem): no Plan or credits row', () => {
    assert({
      given: 'billing disabled for this deployment',
      should: 'hide Plan and Your credits and keep Drives',
      actual: glanceRows({ billing: false, ...loaded }).map((row) => row.label),
      expected: ['Drives'],
    });
  });

  test('a route that has not answered', () => {
    assert({
      given: 'no subscription status or drive list yet',
      should: 'show a dash value rather than a made-up figure',
      actual: glanceRows({ billing: true, status: undefined, credits: undefined, drives: undefined }).map((row) => row.value),
      expected: [null, null, null],
    });
  });
});

describe('overviewGroups()', () => {
  test('the nav groups in SPEC order, without Overview, gated like the nav', () => {
    const groups = overviewGroups(accountNav(cloud));
    assert({
      given: 'the account nav for cloud',
      should: 'list the five groups in order and leave out the overview row',
      actual: [groups.map((group) => group.label), groups[0]?.items.map((item) => item.label)],
      expected: [
        ['You', 'AI', 'Plan & data', 'Connections', 'Other'],
        ['Profile', 'Display', 'Personalization', 'Notifications', 'Hotkeys', 'Privacy'],
      ],
    });
  });

  test('onprem hides Integrations and Google Calendar', () => {
    const labels = overviewGroups(accountNav({ ...cloud, showBilling: false, onPrem: true }))
      .flatMap((group) => group.items.map((item) => item.label));
    assert({
      given: 'an onprem deployment without billing',
      should: 'hide Plan, Billing, Integrations and Google Calendar',
      actual: ['Plan', 'Billing', 'Integrations', 'Google Calendar'].map((label) => labels.includes(label)),
      expected: [false, false, false, false],
    });
  });

  test('every row the board describes has its description', () => {
    assert({
      given: 'the Profile row and the Legal row',
      should: 'carry the board descriptions',
      actual: [describeAccountRow('/account/profile'), describeAccountRow('/account/legal/oss-licenses')],
      expected: ['Name, sign-in, passkeys and devices', 'Privacy Policy, Terms, OSS notices'],
    });
  });
});
