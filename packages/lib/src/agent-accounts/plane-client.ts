/**
 * `createPlaneClient` — how the web process reaches the credential plane
 * (L2·G2; ADR 0005 §3.4). I/O only.
 *
 * The web process holds NO store identity, no plane metadata access and no
 * write-digest key: it holds the plane's URL and service secret, and can ask
 * for exactly three things — store this material (`put`, write-only), deny
 * this account (`revoke`), run this request under this signed grant
 * (`execute`). It can never ask for material back: there is no such route.
 *
 * Every call is signed over method, path, body digest and time
 * (`signPlaneRequest`). A plane that cannot be reached is `plane_unavailable`,
 * never a thrown error a route turns into a 500 with a stack.
 */
import { createHash, createHmac } from 'node:crypto';
import type { PutResult, RevokeResult } from './store/store-adapter';
import type { HttpExecutionResult } from './executor/decide-execution-result';
import type { PlaneExecuteBody, PlanePutBody, PlaneRevokeBody } from './executor/plane-wire';
import { PLANE_ROUTES } from './executor/plane-wire';
import { PLANE_SIGNATURE_HEADER, signPlaneRequest } from './executor/plane-request-signature';

export const PLANE_URL_VAR = 'AGENT_ACCOUNTS_PLANE_URL';
export const PLANE_SERVICE_SECRET_VAR = 'AGENT_ACCOUNTS_PLANE_SERVICE_SECRET';

export type PlaneUnavailable = { readonly ok: false; readonly reason: 'plane_unavailable' };

export type PlaneClient = {
  readonly put: (body: PlanePutBody) => Promise<PutResult | PlaneUnavailable>;
  readonly revoke: (body: PlaneRevokeBody) => Promise<RevokeResult | PlaneUnavailable>;
  readonly execute: (body: PlaneExecuteBody) => Promise<HttpExecutionResult | PlaneUnavailable>;
};

const hmac = (key: string, text: string) => createHmac('sha256', key).update(text).digest('hex');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function createPlaneClient({
  baseUrl,
  secret,
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 30_000,
}: {
  readonly baseUrl: string;
  readonly secret: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}): PlaneClient {
  async function call<T>(path: string, body: unknown): Promise<T | PlaneUnavailable> {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const header = signPlaneRequest({ method: 'POST', path, body: bytes, secret, now: now(), hmac, sha256 });
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PLANE_SIGNATURE_HEADER]: header },
        body: bytes,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) return { ok: false, reason: 'plane_unavailable' };
      return (await response.json()) as T;
    } catch {
      return { ok: false, reason: 'plane_unavailable' };
    }
  }

  return {
    put: (body) => call<PutResult>(PLANE_ROUTES.put, body),
    revoke: (body) => call<RevokeResult>(PLANE_ROUTES.revoke, body),
    execute: (body) => call<HttpExecutionResult>(PLANE_ROUTES.execute, body),
  };
}
