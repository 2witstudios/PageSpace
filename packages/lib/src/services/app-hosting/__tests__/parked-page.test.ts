/**
 * The page the edge serves when it refuses to wake an app.
 *
 * Two things are worth asserting here and they are both about HTTP semantics
 * rather than copy: parked answers 402 (terminal-until-you-act) and not 503,
 * because a 503 is a lie that retry machinery believes — every monitor that
 * honours it would come back and re-run the balance check for an account that
 * has none. And the rendered page must be self-contained and escape the one
 * value it interpolates, since that value is a request header.
 */
import { describe, expect, it } from 'vitest';
import { renderAppRouterPage, retryAfterFor, statusCodeFor } from '../parked-page';
import type { AppRouteDecision } from '../router-core';
import { assert } from '../../../__tests__/riteway';

const parked: AppRouteDecision = { kind: 'parked', reason: 'out_of_credits' };
const deploying: AppRouteDecision = { kind: 'unavailable', reason: 'deploying' };
const failed: AppRouteDecision = { kind: 'unavailable', reason: 'failed' };
const missing: AppRouteDecision = { kind: 'not_found', reason: 'no_such_app' };

describe('statusCodeFor — enforcement is countable, not blended into outages', () => {
  assert({
    given: 'an app parked for want of credits',
    should: 'answer 402 Payment Required rather than a 503 that invites retries',
    actual: statusCodeFor(parked),
    expected: 402,
  });

  assert({
    given: 'an app parked by the metering cron',
    should: 'also answer 402',
    actual: statusCodeFor({ kind: 'parked', reason: 'parked_status' }),
    expected: 402,
  });

  assert({
    given: 'a genuinely transient state',
    should: 'answer 503',
    actual: statusCodeFor(deploying),
    expected: 503,
  });

  assert({
    given: 'no app at this address',
    should: 'answer 404',
    actual: statusCodeFor(missing),
    expected: 404,
  });

  assert({
    given: 'a replay',
    should: 'answer 204 — Fly consumes the response and the client never sees a body',
    actual: statusCodeFor({ kind: 'replay', flyAppName: 'a', state: 'b', timeoutMs: 1500 }),
    expected: 204,
  });
});

describe('retryAfterFor — back a caller off by how long the state will last', () => {
  assert({
    given: 'a deploy in flight',
    should: 'invite a retry in seconds',
    actual: retryAfterFor(deploying),
    expected: 15,
  });

  assert({
    given: 'a failed app waiting on a reconciler or a human',
    should: 'back the caller off much further',
    actual: retryAfterFor(failed),
    expected: 120,
  });

  it.each([
    ['a parked app — retrying cannot change the answer', parked],
    ['a missing app', missing],
  ])('given %s, should offer no Retry-After', (_label, decision) => {
    expect(retryAfterFor(decision)).toBeNull();
  });
});

// The page is PUBLIC — anyone who visits the hostname sees it — so it must not
// claim anything about the owner that is not true. The unavailable copy used to
// say "its owner has been able to see why"; two of the four producers of that
// state are route-level outages logged server-side and surfaced to nobody.
describe('the unavailable page does not promise the owner an explanation', () => {
  it('given a failed app, should not claim the owner can see the reason', () => {
    const html = renderAppRouterPage(failed, 'acme.pagespace.app');
    expect(html).not.toContain('has been able to see');
    expect(html).not.toMatch(/owner.{0,30}(see|knows) why/i);
  });

  it('given a failed app, should point the one reader who can act at where to look', () => {
    expect(renderAppRouterPage(failed, 'acme.pagespace.app')).toContain('check its status in PageSpace');
  });
});

describe('renderAppRouterPage — self-contained, and it escapes the host header', () => {
  it('given any decision, should reference no external asset that would need fetching', () => {
    const html = renderAppRouterPage(parked, 'acme.pagespace.app');
    expect(html).not.toMatch(/<link|<script|<img|url\(/i);
  });

  it('given a hostile Host header, should escape it rather than reflect markup', () => {
    const html = renderAppRouterPage(parked, '<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('given a parked app, should explain that credits ran out and nothing was lost', () => {
    const html = renderAppRouterPage(parked, 'acme.pagespace.app');
    expect(html).toMatch(/credits/i);
    expect(html).toContain('acme.pagespace.app');
  });

  it.each([
    ['parked', parked],
    ['deploying', deploying],
    ['failed', failed],
    ['not_found', missing],
  ])('given a %s decision, should render a complete document with a title', (_label, decision) => {
    const html = renderAppRouterPage(decision, 'acme.pagespace.app');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/<title>.+<\/title>/);
  });
});
