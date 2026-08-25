/**
 * The serving edge's configuration surface.
 *
 * The failure modes worth pinning are all "an unset variable silently disables a
 * protection": an empty apex would make every hostname look like a published-app
 * subdomain, an unset replay secret would emit replays with a blank state, and an
 * unset proxy secret would leave the router endpoint world-callable. Each of
 * those resolves to a value that fails CLOSED, and that is what is asserted here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_ROUTER_FLY_APP_DEFAULT,
  APP_ROUTER_HOST_HEADER,
  APP_ROUTER_KEY_HEADER,
  MIN_ROUTER_SECRET_LENGTH,
  PUBLISHED_APPS_APEX_DEFAULT,
  describeRouterNetworkInvariant,
  resolveAppReplaySecret,
  resolveAppRouterFlyAppName,
  resolveAppRouterProxySecret,
  resolvePublishedAppsApex,
} from '../routing-env';
import { parseAppHost } from '../router-core';
import { assert } from '../../../__tests__/riteway';

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('resolvePublishedAppsApex — never empty, whatever the configuration', () => {
  it('given PUBLISHED_APPS_APEX is unset, should fall back to the default apex', () => {
    delete process.env.PUBLISHED_APPS_APEX;
    expect(resolvePublishedAppsApex()).toBe(PUBLISHED_APPS_APEX_DEFAULT);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
  ])(
    'given a %s override, should fall back rather than yield "" (which would make every host an app)',
    (_label, value) => {
      process.env.PUBLISHED_APPS_APEX = value;
      expect(resolvePublishedAppsApex()).toBe(PUBLISHED_APPS_APEX_DEFAULT);
      // The reason the fallback matters, asserted end to end.
      expect(parseAppHost('victim.example.com', resolvePublishedAppsApex()).kind).toBe('foreign');
    },
  );

  it.each([
    ['a wildcard prefix', '*.apps.example.com'],
    ['a leading dot', '.apps.example.com'],
    ['a trailing dot', 'apps.example.com.'],
    ['mixed case', 'Apps.Example.COM'],
    ['surrounding whitespace', '  apps.example.com  '],
  ])('given %s, should normalize to the bare apex', (_label, value) => {
    process.env.PUBLISHED_APPS_APEX = value;
    expect(resolvePublishedAppsApex()).toBe('apps.example.com');
  });

  assert({
    given: 'the default published-apps apex',
    should: 'be a DIFFERENT registrable domain from the pagespace.site canvas apex (the PSL cookie risk)',
    actual: PUBLISHED_APPS_APEX_DEFAULT.endsWith('pagespace.site'),
    expected: false,
  });
});

describe('resolveAppRouterFlyAppName — one app, reachable under either variable', () => {
  it('given neither variable, should fall back to the proxy app', () => {
    delete process.env.APP_ROUTER_FLY_APP_NAME;
    delete process.env.FLY_PROXY_APP_NAME;
    expect(resolveAppRouterFlyAppName()).toBe(APP_ROUTER_FLY_APP_DEFAULT);
  });

  it('given only the legacy FLY_PROXY_APP_NAME, should use it, so existing deployments keep working', () => {
    delete process.env.APP_ROUTER_FLY_APP_NAME;
    process.env.FLY_PROXY_APP_NAME = 'legacy-proxy';
    expect(resolveAppRouterFlyAppName()).toBe('legacy-proxy');
  });

  it('given both, should prefer the explicit APP_ROUTER_FLY_APP_NAME', () => {
    process.env.APP_ROUTER_FLY_APP_NAME = 'app-router';
    process.env.FLY_PROXY_APP_NAME = 'legacy-proxy';
    expect(resolveAppRouterFlyAppName()).toBe('app-router');
  });

  it('given a blank explicit value, should fall through rather than name an empty app', () => {
    process.env.APP_ROUTER_FLY_APP_NAME = '   ';
    process.env.FLY_PROXY_APP_NAME = 'legacy-proxy';
    expect(resolveAppRouterFlyAppName()).toBe('legacy-proxy');
  });
});

describe('the two secrets fail closed when unset', () => {
  it('given APP_REPLAY_SECRET is unset, should resolve to "" so no replay can be signed', () => {
    delete process.env.APP_REPLAY_SECRET;
    expect(resolveAppReplaySecret()).toBe('');
  });

  it('given APP_ROUTER_PROXY_SECRET is unset, should resolve to "" — which the route reads as refuse-everything', () => {
    delete process.env.APP_ROUTER_PROXY_SECRET;
    expect(resolveAppRouterProxySecret()).toBe('');
  });

  it('given the secrets are configured above the floor, should return them verbatim', () => {
    process.env.APP_REPLAY_SECRET = 'r'.repeat(40);
    process.env.APP_ROUTER_PROXY_SECRET = 'p'.repeat(40);
    expect(resolveAppReplaySecret()).toBe('r'.repeat(40));
    expect(resolveAppRouterProxySecret()).toBe('p'.repeat(40));
  });

  // A guessable proxy secret is not a weaker check, it is the absence of one:
  // the route compares the header against this value, so a short secret leaves
  // the endpoint a world-callable fly-replay emitter. It has to read as unset.
  it.each([
    ['one character', 'a'],
    ['one below the floor', 'p'.repeat(MIN_ROUTER_SECRET_LENGTH - 1)],
  ])(
    'given APP_ROUTER_PROXY_SECRET is %s, should resolve to "" so the route refuses everything',
    (_label, value) => {
      process.env.APP_ROUTER_PROXY_SECRET = value;
      expect(resolveAppRouterProxySecret()).toBe('');
    },
  );

  it('given a secret exactly at the floor, should accept it', () => {
    process.env.APP_ROUTER_PROXY_SECRET = 'p'.repeat(MIN_ROUTER_SECRET_LENGTH);
    expect(resolveAppRouterProxySecret()).toBe('p'.repeat(MIN_ROUTER_SECRET_LENGTH));
  });
});

describe('the header names the proxy and the route have to agree on', () => {
  assert({
    given: 'the host and key header constants',
    should: 'be lowercase, since that is how they are read back off a Request',
    actual: [APP_ROUTER_HOST_HEADER, APP_ROUTER_KEY_HEADER],
    expected: ['x-pagespace-app-host', 'x-pagespace-app-router-key'],
  });
});

describe('describeRouterNetworkInvariant — renders the pair that must agree', () => {
  it('given a configured router app, should report it alongside the published-apps network', () => {
    process.env.APP_ROUTER_FLY_APP_NAME = 'app-router';
    process.env.PUBLISHED_APPS_NETWORK = 'pagespace-apps';
    const described = describeRouterNetworkInvariant();
    expect(described.routerApp).toBe('app-router');
    expect(described.publishedAppsNetwork).toBe('pagespace-apps');
    // The note is what turns a 502 into a one-line diagnosis, so it has to name
    // the actual failure rather than gesture at configuration.
    expect(described.note).toMatch(/cross/i);
    expect(described.note).toMatch(/fixed at create time/i);
  });
});
