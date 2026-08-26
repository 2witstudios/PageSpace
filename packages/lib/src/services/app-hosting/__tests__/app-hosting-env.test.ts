import { afterEach, describe, expect, it } from 'vitest';
import {
  PUBLISHED_APPS_NETWORK_DEFAULT,
  PUBLISHED_APP_DAILY_AWAKE_SECONDS_CAP_DEFAULT,
  PUBLISHED_APP_HIT_STAMP_INTERVAL_SECONDS_DEFAULT,
  PUBLISHED_APP_IDLE_STOP_SECONDS_DEFAULT,
  isAppHostingEnabled,
  resolveDailyAwakeSecondsCap,
  resolveFlyMachinesToken,
  resolveHitStampIntervalSeconds,
  resolveIdleStopSeconds,
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


describe('the lifecycle knobs — idle threshold, hit-stamp throttle, daily cap', () => {
  const knobs = [
    ['PUBLISHED_APP_IDLE_STOP_SECONDS', resolveIdleStopSeconds, PUBLISHED_APP_IDLE_STOP_SECONDS_DEFAULT],
    [
      'PUBLISHED_APP_HIT_STAMP_INTERVAL_SECONDS',
      resolveHitStampIntervalSeconds,
      PUBLISHED_APP_HIT_STAMP_INTERVAL_SECONDS_DEFAULT,
    ],
    [
      'PUBLISHED_APP_DAILY_AWAKE_SECONDS_CAP',
      resolveDailyAwakeSecondsCap,
      PUBLISHED_APP_DAILY_AWAKE_SECONDS_CAP_DEFAULT,
    ],
  ] as const;

  for (const [name, resolve, fallback] of knobs) {
    it(`${name}: given nothing configured, should answer its documented default`, () => {
      delete process.env[name];
      expect(resolve()).toBe(fallback);
    });

    it(`${name}: given a MALFORMED value, should take the default rather than 0`, () => {
      // These knobs bound money and machine lifetime. A typo must not silently
      // switch off the reaper (leaving the fleet awake) or the cap (leaving one
      // app's daily spend unbounded) — which is exactly what parsing to 0 or NaN
      // would do, since 0 is the documented "disabled" value.
      for (const bad of ['abc', '15m', '-30', '1.5', '']) {
        process.env[name] = bad;
        expect(resolve(), `for ${JSON.stringify(bad)}`).toBe(fallback);
      }
    });

    it(`${name}: given an explicit 0, should honour it — 0 is the documented off switch`, () => {
      process.env[name] = '0';
      expect(resolve()).toBe(0);
    });

    it(`${name}: given a valid override, should use it, read at CALL time`, () => {
      process.env[name] = '120';
      expect(resolve()).toBe(120);
      // Re-read, not frozen at module load: an operator retunes these without a
      // deploy, and a test sets them per case.
      process.env[name] = '240';
      expect(resolve()).toBe(240);
    });
  }

  it('the idle threshold is an order of magnitude above the stamp throttle it is compared against', () => {
    // `lastHitAt` trails real traffic by up to the throttle interval, so a
    // threshold near it would reap apps that were being used seconds ago.
    expect(PUBLISHED_APP_IDLE_STOP_SECONDS_DEFAULT).toBeGreaterThan(
      PUBLISHED_APP_HIT_STAMP_INTERVAL_SECONDS_DEFAULT * 5,
    );
  });

  it('the daily cap default is under a full day, so it can actually bind', () => {
    // With the reaper working an app accrues at most 86,400s/day; a cap at or above
    // that would never fire and the runaway bound would be decorative.
    expect(PUBLISHED_APP_DAILY_AWAKE_SECONDS_CAP_DEFAULT).toBeLessThan(86_400);
    expect(PUBLISHED_APP_DAILY_AWAKE_SECONDS_CAP_DEFAULT).toBeGreaterThan(0);
  });
});
