import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PUBLISHED_APP_TRANSITIONS,
  TERMINAL_STATUSES,
  flyAppNameFor,
  isTerminal,
  planProvision,
  planTransition,
} from '../provisioner-core';
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

describe('flyAppNameFor', () => {
  assert({
    given: 'a published-app row id',
    should: 'derive the Fly app name deterministically from it',
    actual: flyAppNameFor('abc123'),
    expected: 'pgs-app-abc123',
  });

  assert({
    given: 'the same id twice',
    should: 'produce the same name, so a retried provision targets the same Fly app',
    actual: flyAppNameFor('abc123') === flyAppNameFor('abc123'),
    expected: true,
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
    actual: planTransition('provisioning', 'building'),
    expected: { allowed: true },
  });

  assert({
    given: 'an illegal edge (provisioning -> running)',
    should: 'refuse as an illegal transition, skipping the build entirely',
    actual: planTransition('provisioning', 'running'),
    expected: { allowed: false, reason: 'illegal_transition' },
  });

  assert({
    given: 'a transition to the same state',
    should: 'refuse as same_state rather than silently succeeding',
    actual: planTransition('running', 'running'),
    expected: { allowed: false, reason: 'same_state' },
  });

  assert({
    given: 'a transition out of destroying',
    should: 'refuse as terminal — a teardown is never resurrected',
    actual: planTransition('destroying', 'running'),
    expected: { allowed: false, reason: 'terminal_state' },
  });

  assert({
    given: 'a parked app whose credits returned',
    should: 'allow parked -> stopped, so the next request wakes it through the normal path',
    actual: planTransition('parked', 'stopped'),
    expected: { allowed: true },
  });

  assert({
    given: 'a parked app',
    should: 'refuse parked -> running, because resuming must still go through the wake path',
    actual: planTransition('parked', 'running'),
    expected: { allowed: false, reason: 'illegal_transition' },
  });

  assert({
    given: 'a failed app being retried',
    should: 'allow failed -> provisioning',
    actual: planTransition('failed', 'provisioning'),
    expected: { allowed: true },
  });

  it('given any non-terminal state, should allow a transition to destroying — teardown is never blocked', () => {
    const blocked = ALL_STATUSES.filter(
      (status) => !isTerminal(status) && !planTransition(status, 'destroying').allowed,
    );
    expect(blocked, `these states refuse teardown: ${blocked.join(', ')}`).toEqual([]);
  });

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
