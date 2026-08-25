/**
 * router-core — the enforcement property, tested without a database or a clock.
 *
 * The claim under test is narrow and load-bearing: **an app whose payer is out of
 * credits is never replayed to**, so its machine is never auto-started, so it
 * never bills. Every other case here exists to stop that claim being satisfied
 * vacuously — by a router that also refuses solvent apps, or by one that reads
 * an unknown status as servable.
 */
import { describe, expect, it } from 'vitest';
import {
  FLY_REPLAY_TIMEOUT_MS,
  MAX_REPLAYABLE_BODY_BYTES,
  buildFlyReplayHeader,
  decideAppRoute,
  exceedsReplayableBody,
  normalizeRequestHost,
  parseAppHost,
  replayCachePolicyFor,
  type RoutableApp,
} from '../router-core';
import { assert } from '../../../__tests__/riteway';

const APEX = 'pagespace.app';

/** A servable, solvent, metered app — the baseline every case perturbs. */
function app(overrides: Partial<RoutableApp> = {}): RoutableApp {
  return {
    flyAppName: 'pgs-app-abc123',
    status: 'running',
    tier: 'metered',
    hasMachine: true,
    ...overrides,
  };
}

function route(appRow: RoutableApp | null, balanceOk = true) {
  return decideAppRoute({ app: appRow, balanceOk, replayState: 'deadbeef' });
}

describe('decideAppRoute — the balance gate is the wake gate', () => {
  assert({
    given: 'a running metered app whose payer is out of credits',
    should: 'refuse to replay, so the machine is never started',
    actual: route(app(), false),
    expected: { kind: 'parked', reason: 'out_of_credits' },
  });

  assert({
    given: 'a STOPPED metered app whose payer is out of credits',
    should: 'still refuse — a stopped machine is exactly the one a replay would wake',
    actual: route(app({ status: 'stopped' }), false),
    expected: { kind: 'parked', reason: 'out_of_credits' },
  });

  assert({
    given: 'a running metered app whose payer can still spend',
    should: 'replay, so the gate is not passing by refusing everyone',
    actual: route(app(), true),
    expected: {
      kind: 'replay',
      flyAppName: 'pgs-app-abc123',
      state: 'deadbeef',
      timeoutMs: FLY_REPLAY_TIMEOUT_MS,
    },
  });

  assert({
    given: 'a DEDICATED app whose payer is out of credits',
    should: 'replay anyway — a flat-rate app has no balance gate to fail',
    actual: route(app({ tier: 'dedicated' }), false).kind,
    expected: 'replay',
  });
});

describe('decideAppRoute — status precedes the live balance read', () => {
  assert({
    given: 'a parked app whose payer has since topped up',
    should: 'stay parked — un-parking belongs to the cron, not to a router that never writes',
    actual: route(app({ status: 'parked' }), true),
    expected: { kind: 'parked', reason: 'parked_status' },
  });

  assert({
    given: 'an app mid-first-deploy with no machine yet',
    should: 'answer deploying — fly-replay auto-starts a machine, it cannot create one',
    actual: route(app({ hasMachine: false })),
    expected: { kind: 'unavailable', reason: 'deploying' },
  });

  it.each([
    ['destroying', 'destroying'],
    ['failed', 'failed'],
  ])('given status %s, should be unavailable', (status, reason) => {
    expect(route(app({ status }))).toEqual({ kind: 'unavailable', reason });
  });

  assert({
    given: 'a status this file has never been taught',
    should: 'fail CLOSED to unavailable, so a status added later cannot start billing machines',
    actual: route(app({ status: 'some_status_added_in_2027' })),
    expected: { kind: 'unavailable', reason: 'deploying' },
  });

  assert({
    given: 'no row for the hostname',
    should: 'answer not_found',
    actual: route(null),
    expected: { kind: 'not_found', reason: 'no_such_app' },
  });

  assert({
    given: 'a deploying app that already has a machine',
    should: 'replay — a rolling deploy still serves the previous version',
    actual: route(app({ status: 'deploying' })).kind,
    expected: 'replay',
  });
});

describe('parseAppHost — only a single label under the apex is an app', () => {
  assert({
    given: 'a single label under the apex',
    should: 'resolve to that subdomain',
    actual: parseAppHost('acme.pagespace.app', APEX),
    expected: { kind: 'subdomain', subdomain: 'acme' },
  });

  assert({
    given: 'a NESTED label under the apex',
    should: 'refuse — the wildcard cert covers one level, and evil.acme.* must not present as an app',
    actual: parseAppHost('evil.acme.pagespace.app', APEX),
    expected: { kind: 'foreign', hostname: 'evil.acme.pagespace.app' },
  });

  assert({
    given: 'the apex itself',
    should: 'be its own outcome, not an app named ""',
    actual: parseAppHost('pagespace.app', APEX),
    expected: { kind: 'apex' },
  });

  assert({
    given: 'a hostname that merely ENDS with the apex text but is not under it',
    should: 'be foreign — notpagespace.app is a different registrable domain',
    actual: parseAppHost('notpagespace.app', APEX),
    expected: { kind: 'foreign', hostname: 'notpagespace.app' },
  });

  assert({
    given: 'a custom domain',
    should: 'be foreign, so the proxy custom-domain block keeps serving it',
    actual: parseAppHost('docs.acme.com', APEX),
    expected: { kind: 'foreign', hostname: 'docs.acme.com' },
  });

  assert({
    given: 'an EMPTY apex (misconfiguration)',
    should: 'treat the host as foreign rather than making every hostname an app',
    actual: parseAppHost('acme.pagespace.app', '').kind,
    expected: 'foreign',
  });

  assert({
    given: 'a label at the 63-character DNS limit',
    should: 'be accepted',
    actual: parseAppHost(`${'a'.repeat(63)}.pagespace.app`, APEX).kind,
    expected: 'subdomain',
  });

  assert({
    given: 'a label one character past the DNS limit',
    should: 'be refused',
    actual: parseAppHost(`${'a'.repeat(64)}.pagespace.app`, APEX).kind,
    expected: 'foreign',
  });

  it.each(['-lead.pagespace.app', 'trail-.pagespace.app', 'under_score.pagespace.app'])(
    'given the invalid label %s, should be foreign',
    (host) => {
      expect(parseAppHost(host, APEX).kind).toBe('foreign');
    },
  );

  assert({
    given: 'an uppercased host with a port and a trailing dot',
    should: 'normalize to the same subdomain',
    actual: parseAppHost('ACME.PageSpace.app.:8080', APEX),
    expected: { kind: 'subdomain', subdomain: 'acme' },
  });

  assert({
    given: 'an apex configured with a leading wildcard and trailing dot',
    should: 'still match, since resolvePublishedAppsApex normalizes both',
    actual: parseAppHost('acme.pagespace.app', 'PageSpace.app'),
    expected: { kind: 'subdomain', subdomain: 'acme' },
  });
});

describe('normalizeRequestHost — an IPv6 literal must not be amputated', () => {
  assert({
    given: 'a bracketed IPv6 literal with a port',
    should: 'strip the port and keep the whole address',
    actual: normalizeRequestHost('[2001:db8::1]:8080'),
    expected: '[2001:db8::1]',
  });

  assert({
    given: 'a bracketed IPv6 literal with NO port',
    should: 'leave the address intact rather than cutting at its last colon',
    actual: normalizeRequestHost('[2001:db8::1]'),
    expected: '[2001:db8::1]',
  });
});

describe('buildFlyReplayHeader — a value that can inject a directive is refused', () => {
  assert({
    given: 'a server-derived app name and state',
    should: 'render the header including the timeout that collapses the cold-start stall',
    actual: buildFlyReplayHeader({ flyAppName: 'pgs-app-abc', state: 'ff00', timeoutMs: 1500 }),
    expected: 'app=pgs-app-abc;state=ff00;timeout=1500',
  });

  it.each([
    ['a semicolon', 'pgs-app;state=evil'],
    ['an equals sign', 'pgs-app=x'],
    ['a comma', 'pgs-app,evil'],
    ['whitespace', 'pgs app'],
  ])('given an app name containing %s, should throw rather than emit a redirectable header', (_l, name) => {
    expect(() => buildFlyReplayHeader({ flyAppName: name, state: 'ff', timeoutMs: 1500 })).toThrow();
  });

  it('given a state carrying header grammar, should throw', () => {
    expect(() =>
      buildFlyReplayHeader({ flyAppName: 'pgs-app', state: 'a;app=victim', timeoutMs: 1500 }),
    ).toThrow();
  });

  it.each([
    ['empty', ''],
  ])('given a %s app name, should throw', (_l, name) => {
    expect(() => buildFlyReplayHeader({ flyAppName: name, state: 'ff', timeoutMs: 1500 })).toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN])('given the invalid timeout %s, should throw', (timeoutMs) => {
    expect(() => buildFlyReplayHeader({ flyAppName: 'a', state: 'b', timeoutMs })).toThrow();
  });

  assert({
    given: "Fly's documented cold-start stall",
    should: 'be collapsed to 1500ms rather than the ~7.5s default',
    actual: FLY_REPLAY_TIMEOUT_MS,
    expected: 1500,
  });
});

describe('exceedsReplayableBody — the 1MB replay ceiling', () => {
  assert({
    given: 'a body exactly at the limit',
    should: 'be replayable',
    actual: exceedsReplayableBody(String(MAX_REPLAYABLE_BODY_BYTES)),
    expected: false,
  });

  assert({
    given: 'a body one byte past the limit',
    should: 'be refused at the edge rather than 502-ing at Fly',
    actual: exceedsReplayableBody(String(MAX_REPLAYABLE_BODY_BYTES + 1)),
    expected: true,
  });

  it.each([
    ['a chunked request declaring no length', null],
    ['an absent header', undefined],
    ['a non-numeric header', 'banana'],
    ['a negative length', '-5'],
  ])('given %s, should answer false rather than guess', (_label, header) => {
    expect(exceedsReplayableBody(header)).toBe(false);
  });

  assert({
    given: "Fly's replay body ceiling",
    should: 'be 1MB, the value the upload-to-Tigris constraint is derived from',
    actual: MAX_REPLAYABLE_BODY_BYTES,
    expected: 1_048_576,
  });
});

describe('replayCachePolicyFor — the cache would skip the gate', () => {
  assert({
    given: 'a metered app',
    should: 'never be cacheable, because the router hop IS the balance check',
    actual: replayCachePolicyFor('metered'),
    expected: 'no-cache',
  });

  assert({
    given: 'a dedicated app',
    should: 'be cacheable — flat-rate billing has no gate to bypass',
    actual: replayCachePolicyFor('dedicated'),
    expected: 'cacheable',
  });

  assert({
    given: 'an unrecognized tier',
    should: 'fail closed to no-cache',
    actual: replayCachePolicyFor('experimental'),
    expected: 'no-cache',
  });
});
