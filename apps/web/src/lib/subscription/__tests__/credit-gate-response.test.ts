import { describe, it, expect } from 'vitest';
import { creditGatePayload, creditGateErrorResponse } from '../credit-gate-response';

describe('creditGatePayload', () => {
  it('maps the in-flight cap to a 429 too_many_in_flight', () => {
    expect(creditGatePayload('too_many_in_flight')).toMatchObject({
      status: 429,
      error: 'too_many_in_flight',
    });
  });

  it('maps out_of_credits to a 402', () => {
    expect(creditGatePayload('out_of_credits')).toMatchObject({ status: 402, error: 'out_of_credits' });
  });

  it('maps the per-user/day exposure cap to a 429 daily_cap_exceeded (retry tomorrow, not buy)', () => {
    expect(creditGatePayload('daily_cap_exceeded')).toMatchObject({
      status: 429,
      error: 'daily_cap_exceeded',
    });
  });

  it('maps needs_init (an unexpected uninitialized balance) to a 402, not a 429', () => {
    expect(creditGatePayload('needs_init').status).toBe(402);
  });
});

describe('creditGateErrorResponse', () => {
  it('returns a NextResponse carrying the mapped status and JSON body', async () => {
    const res = creditGateErrorResponse('too_many_in_flight');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('too_many_in_flight');
    expect(typeof body.message).toBe('string');
  });

  it('returns 402 for an exhausted balance', async () => {
    const res = creditGateErrorResponse('out_of_credits');
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('out_of_credits');
  });
});
