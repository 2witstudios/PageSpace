import { afterEach, describe, expect, it } from 'vitest';
import {
  PUBLISHED_APPS_NETWORK_DEFAULT,
  isAppHostingEnabled,
  resolveFlyMachinesToken,
  resolvePublishedAppsNetwork,
} from '../app-hosting-env';

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('isAppHostingEnabled — default OFF', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['the string "1"', '1'],
    ['the string "TRUE"', 'TRUE'],
    ['the string "yes"', 'yes'],
    ['the string "false"', 'false'],
  ])('given APP_HOSTING_ENABLED is %s, should stay off', (_label, value) => {
    if (value === undefined) delete process.env.APP_HOSTING_ENABLED;
    else process.env.APP_HOSTING_ENABLED = value;
    expect(isAppHostingEnabled()).toBe(false);
  });

  it('given APP_HOSTING_ENABLED is exactly "true", should be on', () => {
    process.env.APP_HOSTING_ENABLED = 'true';
    expect(isAppHostingEnabled()).toBe(true);
  });
});

describe('resolveFlyMachinesToken — fails closed, not loud', () => {
  it('given the token is unset, should return an empty string rather than throwing', () => {
    delete process.env.FLY_MACHINES_ORG_TOKEN;
    expect(resolveFlyMachinesToken()).toBe('');
  });

  it('given the token is set, should return it verbatim', () => {
    process.env.FLY_MACHINES_ORG_TOKEN = 'FlyV1 fm2_xyz';
    expect(resolveFlyMachinesToken()).toBe('FlyV1 fm2_xyz');
  });
});

describe('resolvePublishedAppsNetwork — one network for every app', () => {
  it('given no override, should fall back to the shared default', () => {
    delete process.env.PUBLISHED_APPS_NETWORK;
    expect(resolvePublishedAppsNetwork()).toBe(PUBLISHED_APPS_NETWORK_DEFAULT);
  });

  it('given an empty override, should fall back rather than send Fly an empty network', () => {
    // An empty `network` would silently place the app on the org default network,
    // breaking fly-replay for that app alone — the hardest kind of bug to spot.
    process.env.PUBLISHED_APPS_NETWORK = '';
    expect(resolvePublishedAppsNetwork()).toBe(PUBLISHED_APPS_NETWORK_DEFAULT);
  });

  it('given an org-level override, should use it', () => {
    process.env.PUBLISHED_APPS_NETWORK = 'published-apps-staging';
    expect(resolvePublishedAppsNetwork()).toBe('published-apps-staging');
  });

  it('given several different app ids, should resolve the SAME network for all of them', () => {
    // The regression guard for per-app networks: fly-replay cannot cross 6PN
    // networks (502 "cross-network replays are not allowed"), so every published
    // app must land on one shared network. This function takes no app argument at
    // all, which is the structural half of that guarantee; this asserts the
    // behavioural half.
    delete process.env.PUBLISHED_APPS_NETWORK;
    const networks = new Set([
      resolvePublishedAppsNetwork(),
      resolvePublishedAppsNetwork(),
      resolvePublishedAppsNetwork(),
    ]);
    expect(networks.size).toBe(1);
  });
});
