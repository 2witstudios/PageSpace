/**
 * The web → credential-plane service signature (L2·G2): `signPlaneRequest`
 * formats it, `decidePlaneRequestSignature` decides it. Pure: HMAC and hash
 * are injected.
 *
 * The plane serves three callers — the ingress handler (`put`), the
 * management path (`revoke`) and the HTTP executor path (`execute`, which
 * additionally carries a signed grant, its real authority). All of them hold
 * the plane's shared service secret (`AGENT_ACCOUNTS_PLANE_SERVICE_SECRET`,
 * ≥ 32 characters). The signature covers `t.METHOD.path.sha256(body)`, so a
 * captured header cannot be replayed on another route, another body, or after
 * the window. This authenticates the CALLER; it grants no credential — `put`
 * is write-only, `revoke` only denies, and `execute` still needs a grant.
 */
import { secureCompare } from '../../auth/secure-compare';

export const PLANE_SIGNATURE_HEADER = 'x-pagespace-plane-signature';
export const PLANE_SIGNATURE_MAX_AGE_MS = 60_000;
const MIN_SECRET_LENGTH = 32;

type Hmac = (key: string, text: string) => string;
type Sha256 = (bytes: Uint8Array) => string;

type SignatureInput = {
  readonly method: string;
  readonly path: string;
  readonly body: Uint8Array;
  readonly secret: string;
  readonly now: number;
  readonly hmac: Hmac;
  readonly sha256: Sha256;
};

const payloadOf = (timestamp: number, input: Pick<SignatureInput, 'method' | 'path' | 'body' | 'sha256'>) =>
  `${timestamp}.${input.method.toUpperCase()}.${input.path}.${input.sha256(input.body)}`;

export function signPlaneRequest(input: SignatureInput): string {
  return `t=${input.now},v1=${input.hmac(input.secret, payloadOf(input.now, input))}`;
}

export type PlaneSignatureVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: 'malformed' | 'stale' | 'bad_signature' | 'secret_invalid' };

export function decidePlaneRequestSignature(input: SignatureInput & { readonly header: string | null }): PlaneSignatureVerdict {
  if (typeof input.secret !== 'string' || input.secret.length < MIN_SECRET_LENGTH) return { ok: false, reason: 'secret_invalid' };
  const match = input.header === null ? null : /^t=(\d{1,16}),v1=([0-9a-f]{64})$/.exec(input.header);
  if (match === null) return { ok: false, reason: 'malformed' };
  const timestamp = Number(match[1]);
  if (Math.abs(input.now - timestamp) > PLANE_SIGNATURE_MAX_AGE_MS) return { ok: false, reason: 'stale' };
  const expected = input.hmac(input.secret, payloadOf(timestamp, input));
  return secureCompare(expected, match[2]!) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
