import { describe, it, expect, afterEach, vi } from 'vitest';
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

describe('creditGatePayload — requires_funding (ADR 0007 Decision 9)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('given requires_funding, should be a 402 whose claim_url is the agent claim endpoint under the issuer', () => {
    vi.stubEnv('WEB_APP_URL', 'https://pagespace.example');

    const payload = creditGatePayload('requires_funding');

    expect(payload.status).toBe(402);
    expect(payload.error).toBe('requires_funding');
    expect(payload.claim_url).toBe('https://pagespace.example/api/agent/claim');
  });

  it('given requires_funding, should tell the agent to have a human claim it and point at /auth.md', () => {
    vi.stubEnv('WEB_APP_URL', 'https://pagespace.example');

    const { message } = creditGatePayload('requires_funding');

    expect(message).toMatch(/claim/i);
    expect(message).toContain('https://pagespace.example/auth.md');
  });

  it('given any human-facing denial, should carry no claim_url', () => {
    expect(creditGatePayload('out_of_credits').claim_url).toBeUndefined();
    expect(creditGatePayload('too_many_in_flight').claim_url).toBeUndefined();
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

  it('given requires_funding, should return 402 with {error, message, claim_url}', async () => {
    vi.stubEnv('WEB_APP_URL', 'https://pagespace.example');
    const res = creditGateErrorResponse('requires_funding');
    vi.unstubAllEnvs();

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['claim_url', 'error', 'message']);
    expect(body.claim_url).toBe('https://pagespace.example/api/agent/claim');
  });

  it('given out_of_credits, should keep the body to exactly {error, message}', async () => {
    const res = creditGateErrorResponse('out_of_credits');
    expect(Object.keys(await res.json()).sort()).toEqual(['error', 'message']);
  });

  it('returns 402 for an exhausted balance', async () => {
    const res = creditGateErrorResponse('out_of_credits');
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe('out_of_credits');
  });
});
