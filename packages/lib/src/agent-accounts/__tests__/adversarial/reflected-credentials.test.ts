import { describe, it, expect } from 'vitest';
import { redactKnownValues } from '../../redact-known-values';

// Threat model Λ10, A1 (ASI01). An authorized site can echo the credential;
// redaction is a tripwire, not a boundary. The scrub itself is a pure row;
// the rows that need a live executor, a browser or a terminal belong to the
// gates that build them.

const CANARY = 'ghp_canary_4b81c0f2e7';

describe('adversarial: reflected-credentials', () => {
  it('given a response body echoing the canary secret verbatim, should scrub it before release and record a tripwire audit event', () => {
    const actual = redactKnownValues({ text: `{"echo":"${CANARY}"}`, knownValues: [CANARY] });
    expect(actual).toEqual({ text: '{"echo":"[redacted]"}', redacted: true });
  });

  it.each([
    ['base64', Buffer.from(CANARY).toString('base64')],
    ['percent-encoded underscores', CANARY.replace(/_/g, '%5F')],
    ['split across two fields', `${CANARY.slice(0, 10)}","b":"${CANARY.slice(10)}`],
    ['hex', Buffer.from(CANARY).toString('hex')],
  ])('given a response echoing the canary %s, should be reported as a known non-guarantee (documented miss, not a failure)', (_label, echoed) => {
    const actual = redactKnownValues({ text: `{"echo":"${echoed}"}`, knownValues: [CANARY] });
    expect(actual.redacted).toBe(false);
  });

  it('given a header value echoing the secret, should be filtered from the released header set by the same scrub', () => {
    const released = [['x-echo', CANARY] as const, ['content-type', 'application/json'] as const].map(
      ([name, value]) => [name, redactKnownValues({ text: value, knownValues: [CANARY] }).text] as const,
    );
    expect(released).toEqual([
      ['x-echo', '[redacted]'],
      ['content-type', 'application/json'],
    ]);
  });

  it('given a scrub that fired, should report the tripwire so the audit records that the site handed the value back', () => {
    const actual = [redactKnownValues({ text: CANARY, knownValues: [CANARY] }).redacted, redactKnownValues({ text: 'clean', knownValues: [CANARY] }).redacted];
    expect(actual).toEqual([true, false]);
  });

  it.todo('given a canary-secret account, should never appear in any tool result, terminal output, screenshot or DOM dump across the G2 slice — I/O row, owned by G2 (http executor + canary account)');
});
