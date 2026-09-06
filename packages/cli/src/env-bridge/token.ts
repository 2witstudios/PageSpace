/**
 * Earn an `env:bridge` socket token by proving possession of the machine key
 * (invariant 2: challenge / proof-of-possession, never a stored secret). The
 * token is short-lived (`getEnvBridgeTokenPolicy`, ten minutes) and is minted
 * FRESH for every socket connect — `ws-client.ts` calls this on each
 * (re)connect and never caches the result. `pagespace env token` is the
 * standalone form of the same round trip.
 */
import type { MachineHostCredential } from '../credentials/serialize.js';
import { encodeChallenge, type SignWithMachineKey } from './keypair.js';
import { assertSecureHost } from './secure-host.js';

type Fetch = typeof globalThis.fetch;

export interface MintBridgeTokenInput {
  readonly host: string;
  readonly credential: MachineHostCredential;
  readonly fetch: Fetch;
  readonly sign: SignWithMachineKey;
}

export interface MintedBridgeToken {
  readonly token: string;
  readonly expiresInMs: number;
  readonly envId: string;
}

export class BridgeTokenError extends Error {
  constructor(
    readonly stage: 'challenge' | 'redeem',
    message: string,
  ) {
    super(message);
    this.name = 'BridgeTokenError';
  }
}

/** The server's refusal, as a one-line reason the user can act on; never the raw body. */
export async function refusalOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { reason?: unknown; error?: unknown } | null;
  const reason = typeof body?.reason === 'string' ? body.reason : typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
  return `${reason} (HTTP ${response.status})`;
}

export async function postJson(fetch: Fetch, url: string, body: unknown): Promise<Response> {
  // redirect: 'error' — a cross-origin 307/308 would forward the enrollmentId, nonce and machine signature to another origin, which could replay them (CWE-200).
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), redirect: 'error' });
}

export async function mintBridgeToken({ host, credential, fetch, sign }: MintBridgeTokenInput): Promise<MintedBridgeToken> {
  assertSecureHost(host);
  const { enrollmentId } = credential;
  const challengeResponse = await fetch(`${host}/api/env-bridge/token?enrollmentId=${encodeURIComponent(enrollmentId)}`, { headers: { accept: 'application/json' }, redirect: 'error' });
  if (!challengeResponse.ok) throw new BridgeTokenError('challenge', `Challenge refused: ${await refusalOf(challengeResponse)}`);
  const challenge = (await challengeResponse.json()) as { nonce: string; expiresAt: string };

  const signature = sign(credential.privateKey, encodeChallenge({ nonce: challenge.nonce, enrollmentId, exp: Date.parse(challenge.expiresAt) }));
  const redeemResponse = await postJson(fetch, `${host}/api/env-bridge/token`, { enrollmentId, nonce: challenge.nonce, signature });
  if (!redeemResponse.ok) throw new BridgeTokenError('redeem', `Token refused: ${await refusalOf(redeemResponse)}`);
  return (await redeemResponse.json()) as MintedBridgeToken;
}
