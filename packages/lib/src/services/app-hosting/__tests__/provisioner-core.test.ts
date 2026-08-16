import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PUBLISHED_APP_TRANSITIONS,
  TERMINAL_STATUSES,
  checkStatusInvariants,
  flyAppNameFor,
  isTerminal,
  planProvision,
  planTransition,
} from '../provisioner-core';
import type { PublishedAppStatusColumns } from '../provisioner-core';
import type { PublishedAppStatus } from '@pagespace/db/schema/published-apps';
import { assert } from './riteway';

const ALL_STATUSES: PublishedAppStatus[] = [
  'provisioning',
  'building',
  'deploying',
  'running',
  'stopped',
  'parked',
  'destroying',
  'failed',
];

/**
 * A row that satisfies every status-coupled CHECK, so a transition test exercises
 * the EDGE rather than tripping over a missing column.
 */
const SERVABLE: PublishedAppStatusColumns = {
  imageDigest: 'sha256:abc',
  machineId: 'm1',
  tier: 'metered',
};

describe('flyAppNameFor', () => {
  assert({
    given: 'a published-app row id',
    should: 'derive the Fly app name deterministically from it',
    actual: flyAppNameFor('abc123'),
    expected: 'pgs-app-abc123',
  });

  assert({
    given: 'a different row id',
    should: 'derive a different name, so two apps can never share one Fly app',
    actual: flyAppNameFor('def456'),
    expected: 'pgs-app-def456',
  });
});

describe('the shared-network invariant', () => {
  // fly-replay cannot cross 6PN networks (502 "cross-network replays are not
  // allowed"), so a per-app network derivation must not exist. This asserts the
  // ABSENCE of one — it is the regression guard for reintroducing the design the
  // Phase 0 spike refuted.
  const source = readFileSync(join(__dirname, '..', 'provisioner-core.ts'), 'utf8');

  assert({
    given: 'the pure provisioner core',
    should: 'export no per-app network derivation',
    actual: /export function networkNameFor/.test(source),
    expected: false,
  });
});

describe('planTransition', () => {
  assert({
    given: 'a legal edge (provisioning -> building)',
    should: 'allow it',
    actual: planTransition('provisioning', 'building', SERVABLE),
    expected: { allowed: true },
  });

  assert({
    given: 'an illegal edge (provisioning -> running)',
    should: 'refuse as an illegal transition, skipping the build entirely',
    actual: planTransition('provisioning', 'running', SERVABLE),
    expected: { allowed: false, reason: 'illegal_transition' },
  });

  assert({
    given: 'a transition to the same state',
    should: 'refuse as same_state rather than silently succeeding',
    actual: planTransition('running', 'running', SERVABLE),
    expected: { allowed: false, reason: 'same_state' },
  });

  assert({
    given: 'a transition out of destroying',
    should: 'refuse as terminal — a teardown is never resurrected',
    actual: planTransition('destroying', 'running', SERVABLE),
    expected: { allowed: false, reason: 'terminal_state' },
  });

  assert({
    given: 'a parked app whose credits returned',
    should: 'allow parked -> stopped, so the next request wakes it through the normal path',
    actual: planTransition('parked', 'stopped', SERVABLE),
    expected: { allowed: true },
  });

  assert({
    given: 'a parked app',
    should: 'refuse parked -> running, because resuming must still go through the wake path',
    actual: planTransition('parked', 'running', SERVABLE),
    expected: { allowed: false, reason: 'illegal_transition' },
  });

  assert({
    given: 'a failed app being retried',
    should: 'allow failed -> provisioning',
    actual: planTransition('failed', 'provisioning', SERVABLE),
    expected: { allowed: true },
  });

  it('given any state other than destroying itself, should allow a transition to destroying — teardown is never blocked', () => {
    const blocked = ALL_STATUSES.filter(
      // Only `destroying` is excluded, because it IS the teardown state. `failed`
      // is in TERMINAL_STATUSES but is the state most likely to need tearing down,
      // so an isTerminal() filter here would quietly stop testing the case that
      // matters most.
      (status) => status !== 'destroying' && !planTransition(status, 'destroying', SERVABLE).allowed,
    );
    expect(blocked, `these states refuse teardown: ${blocked.join(', ')}`).toEqual([]);
  });

  it('given a teardown of an app with no image or machine, should still allow it', () => {
    // A provision that died before its first build has neither column, and that is
    // exactly the row an operator needs to destroy. No CHECK couples `destroying`
    // to anything, so nothing here may refuse it.
    const bare = { imageDigest: null, machineId: null, tier: 'metered' as const };
    const blocked = ALL_STATUSES.filter(
      (status) => status !== 'destroying' && !planTransition(status, 'destroying', bare).allowed,
    );
    expect(blocked).toEqual([]);
  });
});

describe('the transition table agrees with the CHECK constraints', () => {
  // Each of these edges is LEGAL by the table and REJECTED by the database unless
  // the coupled column lands in the same write. Before this agreement existed, the
  // pure layer said "allowed", the update raised, and an entry point documented as
  // returning a denial threw instead — aborting the caller's transaction.
  assert({
    given: 'deploying -> running with no machine id',
    should: 'refuse as running_requires_machine, the name of the constraint that would raise',
    actual: planTransition('deploying', 'running', { ...SERVABLE, machineId: null }),
    expected: { allowed: false, reason: 'running_requires_machine' },
  });

  assert({
    given: 'building -> deploying with no image digest',
    should: 'refuse as serving_requires_image',
    actual: planTransition('building', 'deploying', { ...SERVABLE, imageDigest: null }),
    expected: { allowed: false, reason: 'serving_requires_image' },
  });

  assert({
    given: 'deploying -> running with no image digest',
    should: 'refuse as serving_requires_image',
    actual: planTransition('deploying', 'running', { ...SERVABLE, imageDigest: null }),
    expected: { allowed: false, reason: 'serving_requires_image' },
  });

  assert({
    given: 'running -> parked on a dedicated app',
    should: 'refuse as parked_is_metered_only — parking is a credit action a flat SKU never takes',
    actual: planTransition('running', 'parked', { ...SERVABLE, tier: 'dedicated' }),
    expected: { allowed: false, reason: 'parked_is_metered_only' },
  });

  assert({
    given: 'deploying -> running WITH the machine id and digest supplied in the same write',
    should: 'allow it — the coupled columns travel with the status',
    actual: planTransition('deploying', 'running', SERVABLE),
    expected: { allowed: true },
  });

  it('given a status with no coupled constraint, should not be constrained by these columns', () => {
    const bare = { imageDigest: null, machineId: null, tier: 'metered' as const };
    const unconstrained: PublishedAppStatus[] = ['provisioning', 'building', 'stopped', 'failed'];
    const violations = unconstrained.filter((status) => checkStatusInvariants(status, bare) !== null);
    expect(violations).toEqual([]);
  });
});

describe('the transition table itself', () => {
  it('given every status, should have an entry in the transition table', () => {
    const missing = ALL_STATUSES.filter((status) => PUBLISHED_APP_TRANSITIONS[status] === undefined);
    expect(missing).toEqual([]);
  });

  it('given every declared edge, should point at a real status', () => {
    const bogus: string[] = [];
    for (const from of ALL_STATUSES) {
      for (const to of PUBLISHED_APP_TRANSITIONS[from]) {
        if (!ALL_STATUSES.includes(to)) bogus.push(`${from} -> ${to}`);
      }
    }
    expect(bogus).toEqual([]);
  });
});

describe('isTerminal', () => {
  assert({
    given: 'the terminal set',
    should: 'be exactly failed and destroying',
    actual: [...TERMINAL_STATUSES].sort(),
    expected: ['destroying', 'failed'],
  });

  assert({
    given: 'a running app',
    should: 'not be terminal',
    actual: isTerminal('running'),
    expected: false,
  });
});

describe('planProvision', () => {
  assert({
    given: 'the kill switch off',
    should: 'deny before considering any existing state',
    actual: planProvision({ enabled: false, existingStatus: null }),
    expected: { action: 'deny', reason: 'disabled' },
  });

  assert({
    given: 'the kill switch off AND an existing failed row',
    should: 'still deny — no combination of state can talk a dark deployment into provisioning',
    actual: planProvision({ enabled: false, existingStatus: 'failed' }),
    expected: { action: 'deny', reason: 'disabled' },
  });

  assert({
    given: 'no existing row',
    should: 'create',
    actual: planProvision({ enabled: true, existingStatus: null }),
    expected: { action: 'create' },
  });

  assert({
    given: 'an existing failed row',
    should: 'create — re-provisioning is the retry path',
    actual: planProvision({ enabled: true, existingStatus: 'failed' }),
    expected: { action: 'create' },
  });

  assert({
    given: 'an existing running row',
    should: 'no-op rather than create a second Fly app for the same page',
    actual: planProvision({ enabled: true, existingStatus: 'running' }),
    expected: { action: 'noop', existingStatus: 'running' },
  });
});

describe('purity', () => {
  // The decision layer must stay testable without a database, a network, or a
  // clock. Enforced by inspection of the source, mirroring credit-core's test.
  const source = readFileSync(join(__dirname, '..', 'provisioner-core.ts'), 'utf8');
  const runtimeImports = source
    .split('\n')
    .filter((line) => /^import /.test(line) && !/^import type /.test(line));

  assert({
    given: 'the pure provisioner core',
    should: 'have no runtime imports at all — only type-only ones',
    actual: runtimeImports,
    expected: [],
  });

  assert({
    given: 'the pure provisioner core',
    should: 'never reach for a clock',
    actual: /Date\.now\(\)|new Date\(/.test(source),
    expected: false,
  });

  assert({
    given: 'the pure provisioner core',
    should: 'never read process.env',
    actual: /process\.env/.test(source),
    expected: false,
  });
});
