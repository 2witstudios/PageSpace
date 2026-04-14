import { startRegistration } from '@simplewebauthn/browser';
import { buildPasskeyRegisteredDeepLink } from './passkeyExternal';

type RegisterOptionsJSON = Parameters<typeof startRegistration>[0]['optionsJSON'];

export interface RunPasskeyRegisterExternalCeremonyInput {
  handoffToken: string;
  deviceName: string;
  fetchImpl?: typeof fetch;
}

export type RunPasskeyRegisterExternalCeremonyResult =
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

export async function runPasskeyRegisterExternalCeremony(
  input: RunPasskeyRegisterExternalCeremonyInput,
): Promise<RunPasskeyRegisterExternalCeremonyResult> {
  const fetchImpl = input.fetchImpl ?? fetch;

  const optionsRes = await fetchImpl('/api/auth/passkey/register/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handoffToken: input.handoffToken }),
  });
  if (!optionsRes.ok) {
    return { ok: false, error: await readError(optionsRes, 'Failed to fetch registration options') };
  }
  const { options } = (await optionsRes.json()) as { options: RegisterOptionsJSON };

  let registrationResponse: Awaited<ReturnType<typeof startRegistration>>;
  try {
    registrationResponse = await startRegistration({ optionsJSON: options });
  } catch (err) {
    if (err instanceof Error && err.name === 'NotAllowedError') {
      return { ok: false, error: 'Registration was cancelled' };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Registration failed',
    };
  }

  const verifyRes = await fetchImpl('/api/auth/passkey/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handoffToken: input.handoffToken,
      response: registrationResponse,
      expectedChallenge: options.challenge,
      name: input.deviceName,
    }),
  });
  if (!verifyRes.ok) {
    return { ok: false, error: await readError(verifyRes, 'Registration verification failed') };
  }

  return { ok: true, deepLink: buildPasskeyRegisteredDeepLink() };
}
