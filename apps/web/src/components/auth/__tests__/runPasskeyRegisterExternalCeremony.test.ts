import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(),
}));

import { startRegistration } from '@simplewebauthn/browser';
import { runPasskeyRegisterExternalCeremony } from '../runPasskeyRegisterExternalCeremony';

const registrationResponse = {
  id: 'cred-new',
  rawId: 'raw',
  type: 'public-key',
  response: { attestationObject: 'att', clientDataJSON: 'cdj' },
};

function mockFetch(handlers: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (input: unknown, _init?: unknown) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) return handler();
    }
    throw new Error(`Unmocked fetch: ${url}`);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('runPasskeyRegisterExternalCeremony', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(startRegistration).mockResolvedValue(
      registrationResponse as unknown as Awaited<ReturnType<typeof startRegistration>>
    );
  });

  it('runs options → startRegistration → verify → returns passkey-registered deep link', async () => {
    const fetchImpl = mockFetch({
      '/api/auth/passkey/register/options': () =>
        jsonResponse({ options: { challenge: 'chal-1' } }),
      '/api/auth/passkey/register': () =>
        jsonResponse({ success: true, passkeyId: 'pk-1' }),
    });

    const result = await runPasskeyRegisterExternalCeremony({
      handoffToken: 'handoff-abc',
      deviceName: 'Jono Mac',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.deepLink).toBe('pagespace://passkey-registered');
  });

  it('sends the handoff token to both options and verify endpoints', async () => {
    const fetchImpl = mockFetch({
      '/api/auth/passkey/register/options': () =>
        jsonResponse({ options: { challenge: 'chal-1' } }),
      '/api/auth/passkey/register': () =>
        jsonResponse({ success: true, passkeyId: 'pk-1' }),
    });

    await runPasskeyRegisterExternalCeremony({
      handoffToken: 'handoff-abc',
      deviceName: 'Jono Mac',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const optionsCall = fetchImpl.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0] === '/api/auth/passkey/register/options'
    );
    expect(optionsCall).toBeDefined();
    const optionsBody = JSON.parse((optionsCall![1] as RequestInit).body as string);
    expect(optionsBody).toEqual({ handoffToken: 'handoff-abc' });

    const verifyCall = fetchImpl.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0] === '/api/auth/passkey/register'
    );
    expect(verifyCall).toBeDefined();
    const verifyBody = JSON.parse((verifyCall![1] as RequestInit).body as string);
    expect(verifyBody).toMatchObject({
      handoffToken: 'handoff-abc',
      expectedChallenge: 'chal-1',
      name: 'Jono Mac',
      response: registrationResponse,
    });
  });

  it('returns an error result when the options endpoint rejects the handoff', async () => {
    const fetchImpl = mockFetch({
      '/api/auth/passkey/register/options': () =>
        jsonResponse({ error: 'Invalid or expired handoff token', code: 'HANDOFF_INVALID' }, 401),
    });

    const result = await runPasskeyRegisterExternalCeremony({
      handoffToken: 'bad',
      deviceName: 'Jono Mac',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error).toMatch(/handoff/i);
    expect(startRegistration).not.toHaveBeenCalled();
  });

  it('returns an error result when the verify endpoint fails', async () => {
    const fetchImpl = mockFetch({
      '/api/auth/passkey/register/options': () =>
        jsonResponse({ options: { challenge: 'c' } }),
      '/api/auth/passkey/register': () =>
        jsonResponse({ error: 'Verification failed' }, 400),
    });

    const result = await runPasskeyRegisterExternalCeremony({
      handoffToken: 'handoff',
      deviceName: 'd',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error).toMatch(/verification/i);
  });

  it('returns an error result with code=CANCELLED when startRegistration is cancelled by the user', async () => {
    vi.mocked(startRegistration).mockRejectedValueOnce(
      Object.assign(new Error('timed out or not allowed'), { name: 'NotAllowedError' })
    );

    const fetchImpl = mockFetch({
      '/api/auth/passkey/register/options': () =>
        jsonResponse({ options: { challenge: 'c' } }),
    });

    const result = await runPasskeyRegisterExternalCeremony({
      handoffToken: 'handoff',
      deviceName: 'd',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error).toMatch(/cancel/i);
    expect(result.code).toBe('CANCELLED');
  });

  it('returns a friendly already-registered error when startRegistration throws InvalidStateError', async () => {
    vi.mocked(startRegistration).mockRejectedValueOnce(
      Object.assign(new Error('The authenticator recognized an entry'), {
        name: 'InvalidStateError',
      })
    );

    const fetchImpl = mockFetch({
      '/api/auth/passkey/register/options': () =>
        jsonResponse({ options: { challenge: 'c' } }),
    });

    const result = await runPasskeyRegisterExternalCeremony({
      handoffToken: 'handoff',
      deviceName: 'd',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.code).toBe('ALREADY_REGISTERED');
    expect(result.error).toMatch(/already registered on this device/i);
    expect(result.error).toMatch(/different device|security key|iCloud/i);
  });

  it('surfaces the raw message for unknown errors with no code field', async () => {
    vi.mocked(startRegistration).mockRejectedValueOnce(new Error('network failure'));

    const fetchImpl = mockFetch({
      '/api/auth/passkey/register/options': () =>
        jsonResponse({ options: { challenge: 'c' } }),
    });

    const result = await runPasskeyRegisterExternalCeremony({
      handoffToken: 'handoff',
      deviceName: 'd',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error).toBe('network failure');
    expect(result.code).toBeUndefined();
  });
});
