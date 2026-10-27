/**
 * L2·G2 — what the HTTP executor reports, as pure decisions.
 *
 * `decideOperationOutcome`: the audit outcome of what happened on the wire,
 * and the class the caller learns. A failure known to precede sending is
 * `upstream_failed` with no status (a retry is safe); a failure after the
 * request may have left is `unknown` (a write may have landed — never
 * "failed"); a response is `executed` with its status.
 *
 * `decideExecutionResult`: task entry 2026-09-21 — "Callers of the audit-gate
 * executor must act on `outcomeRecorded=false`, because an unrecorded outcome
 * must never be reported as success." A response whose outcome row the chain
 * did not accept is withheld and reported as `outcome_unrecorded`.
 */
import { describe, expect, it } from 'vitest';
import type { ReleasedResponse } from '../../filter-response';
import { decideOperationOutcome } from '../decide-operation-outcome';
import { decideExecutionResult } from '../decide-execution-result';

const released: ReleasedResponse = { status: 200, headers: [['content-type', 'application/json']], body: '{"ok":true}', bodyOmitted: null, truncated: false, redacted: false };

describe('decideOperationOutcome', () => {
  it('given each wire outcome, should map it to the audit outcome and the caller class', () => {
    const actual = [
      decideOperationOutcome({ stage: { kind: 'not_resolved' } }),
      decideOperationOutcome({ stage: { kind: 'not_built' } }),
      decideOperationOutcome({ stage: { kind: 'sent', send: { kind: 'refused', reason: 'non_public_address' } } }),
      decideOperationOutcome({ stage: { kind: 'sent', send: { kind: 'failed', phase: 'before_send', reason: 'tls' } } }),
      decideOperationOutcome({ stage: { kind: 'sent', send: { kind: 'failed', phase: 'after_send', reason: 'timeout' } } }),
      decideOperationOutcome({ stage: { kind: 'sent', send: { kind: 'response', status: 404, headers: [], body: new Uint8Array(0), truncated: false } } }),
    ];
    const expected = [
      { audit: { kind: 'upstream_failed', upstreamStatus: null }, caller: 'refused' },
      { audit: { kind: 'upstream_failed', upstreamStatus: null }, caller: 'refused' },
      { audit: { kind: 'upstream_failed', upstreamStatus: null }, caller: 'upstream_unreachable' },
      { audit: { kind: 'upstream_failed', upstreamStatus: null }, caller: 'upstream_unreachable' },
      { audit: { kind: 'unknown' }, caller: 'outcome_unknown' },
      { audit: { kind: 'executed', upstreamStatus: 404 }, caller: 'response' },
    ];
    expect(actual).toEqual(expected);
  });
});

describe('decideExecutionResult', () => {
  it('given an executed response whose outcome the chain recorded, should release the filtered response', () => {
    const actual = decideExecutionResult({ audited: { ok: true, outcome: { kind: 'executed', upstreamStatus: 200 }, outcomeRecorded: true }, caller: 'response', released });
    const expected = { ok: true, response: released };
    expect(actual).toEqual(expected);
  });

  it('given an executed response whose outcome row the chain did NOT accept, should withhold it and report outcome_unrecorded — never success', () => {
    const actual = decideExecutionResult({ audited: { ok: true, outcome: { kind: 'executed', upstreamStatus: 200 }, outcomeRecorded: false }, caller: 'response', released });
    const expected = { ok: false, reason: 'outcome_unrecorded' };
    expect(actual).toEqual(expected);
  });

  it('given the allowed row never accepted, should report audit_unavailable — nothing ran', () => {
    const actual = decideExecutionResult({ audited: { ok: false, reason: 'audit_unavailable' }, caller: 'response', released: null });
    const expected = { ok: false, reason: 'audit_unavailable' };
    expect(actual).toEqual(expected);
  });

  it('given a refusal, an unreachable upstream or an unknown outcome, should report that class and release no body — whether or not it was recorded', () => {
    const cases = ['refused', 'upstream_unreachable', 'outcome_unknown'] as const;
    const actual = cases.flatMap((caller) => [true, false].map((outcomeRecorded) => decideExecutionResult({ audited: { ok: true, outcome: { kind: 'unknown' }, outcomeRecorded }, caller, released })));
    const expected = cases.flatMap((reason) => [{ ok: false, reason }, { ok: false, reason: reason === 'refused' ? 'refused' : 'outcome_unrecorded' }]);
    expect(actual).toEqual(expected);
  });

  it('given a response class but no released view, should never report success', () => {
    const actual = decideExecutionResult({ audited: { ok: true, outcome: { kind: 'executed', upstreamStatus: 200 }, outcomeRecorded: true }, caller: 'response', released: null });
    const expected = { ok: false, reason: 'outcome_unknown' };
    expect(actual).toEqual(expected);
  });
});
