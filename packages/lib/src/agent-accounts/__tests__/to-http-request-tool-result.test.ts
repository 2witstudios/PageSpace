/**
 * L2·G2 — `toHttpRequestToolResult`: what the `http_request` tool hands the
 * model. Requirement: "Given the tool call and result, should contain only the
 * account id, never a value." The operation result is already filtered by the
 * plane; this mapping adds only the account id and fixed guidance, and each
 * refusal says what the model may do next — above all, an unrecorded outcome
 * is not success and must not be retried automatically.
 */
import { describe, expect, it } from 'vitest';
import type { ApprovalSubject } from '../canonical-request';
import type { RequestDigest } from '../grant';
import { toHttpRequestToolResult } from '../to-http-request-tool-result';

const released = { status: 200, headers: [['content-type', 'application/json'], ['etag', '"1"']] as const, body: '{"temp":7}', bodyOmitted: null, truncated: false, redacted: false };

describe('toHttpRequestToolResult', () => {
  it('given a released response, should return its status, headers as an object and body, naming only the account id', () => {
    const actual = toHttpRequestToolResult({ accountId: 'acct_1', result: { ok: true, response: released } });
    const expected = { ok: true, accountId: 'acct_1', status: 200, headers: { 'content-type': 'application/json', etag: '"1"' }, body: '{"temp":7}', bodyOmitted: null, truncated: false, redacted: false };
    expect(actual).toEqual(expected);
  });

  it('given approval required, should hand the exact digest and the server-rendered subject so a person can approve that request and no other', () => {
    const subject = { origin: 'https://api.example.com:443', method: 'GET', path: '/v1/x', query: [], operation: { class: 'unknown', name: 'generic_request' } } as unknown as ApprovalSubject;
    const verdict = toHttpRequestToolResult({ accountId: 'acct_1', result: { ok: false, reason: 'approval_required', digest: 'd1' as RequestDigest, subject, stepUp: false } });
    const actual = { ok: verdict.ok, error: 'error' in verdict ? verdict.error : null, approval: 'approval' in verdict ? verdict.approval : null };
    const expected = { ok: false, error: 'approval_required', approval: { accountId: 'acct_1', requestDigest: 'd1', subject, stepUp: false } };
    expect(actual).toEqual(expected);
  });

  it('given each refusal, should return its error word and fixed guidance — an unrecorded or unknown outcome warns not to retry', () => {
    const reasons = ['account_unavailable', 'refused', 'outcome_unrecorded', 'outcome_unknown', 'upstream_unreachable'] as const;
    const verdicts = reasons.map((reason) => toHttpRequestToolResult({ accountId: 'acct_1', result: { ok: false, reason } }));
    const actual = verdicts.map((verdict) => ('error' in verdict ? [verdict.error, /do not retry/i.test(verdict.message)] : null));
    const expected = [
      ['account_unavailable', false],
      ['refused', false],
      ['outcome_unrecorded', true],
      ['outcome_unknown', true],
      ['upstream_unreachable', false],
    ];
    expect(actual).toEqual(expected);
  });

  it('given a refused request shape or destination, should name the rule so the model can fix its call', () => {
    const actual = [
      toHttpRequestToolResult({ accountId: 'a', result: { ok: false, reason: 'destination_denied', rule: 'origin_not_allowed' } }),
      toHttpRequestToolResult({ accountId: 'a', result: { ok: false, reason: 'request_refused', rule: 'reserved_header' } }),
    ].map((verdict) => ('rule' in verdict ? [verdict.error, verdict.rule] : null));
    const expected = [
      ['destination_denied', 'origin_not_allowed'],
      ['request_refused', 'reserved_header'],
    ];
    expect(actual).toEqual(expected);
  });
});
