import { startAuthentication } from '@simplewebauthn/browser';
import { buildPasskeyExchangeDeepLink } from './passkeyExternal';

export interface RunPasskeyExternalCeremonyInput {
  deviceId: string;
  deviceName: string;
  fetchImpl?: typeof fetch;
}

export type RunPasskeyExternalCeremonyResult =
  | { ok: true; deepLink: string }
  | { ok: false; error: string };

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

export async function runPasskeyExternalCeremony(
  input: RunPasskeyExternalCeremonyInput,
): Promise<RunPasskeyExternalCeremonyResult> {
  const fetchImpl = input.fetchImpl ?? fetch;

  const csrfRes = await fetchImpl('/api/auth/login-csrf', { method: 'GET' });
  if (!csrfRes.ok) {
    const detail = await readError(csrfRes, 'Failed to fetch CSRF token');
    return { ok: false, error: `CSRF request failed: ${detail}` };
  }
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const optionsRes = await fetchImpl('/api/auth/passkey/authenticate/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrfToken }),
  });
  if (!optionsRes.ok) {
    return { ok: false, error: await readError(optionsRes, 'Failed to fetch passkey options') };
  }
  const { options } = (await optionsRes.json()) as {
    options: { challenge: string };
  };

  let authResponse: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    authResponse = await startAuthentication({
      optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]['optionsJSON'],
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'NotAllowedError') {
      return { ok: false, error: 'Authentication was cancelled' };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Authentication failed',
    };
  }

  const verifyRes = await fetchImpl('/api/auth/passkey/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      response: authResponse,
      expectedChallenge: options.challenge,
      csrfToken,
      platform: 'desktop',
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      desktopExchange: true,
    }),
  });
  if (!verifyRes.ok) {
    return { ok: false, error: await readError(verifyRes, 'Authentication failed') };
  }
  const verifyBody = (await verifyRes.json()) as { desktopExchangeCode?: string };
  if (!verifyBody.desktopExchangeCode) {
    return { ok: false, error: 'Missing desktop exchange code in response' };
  }

  return { ok: true, deepLink: buildPasskeyExchangeDeepLink(verifyBody.desktopExchangeCode) };
}
