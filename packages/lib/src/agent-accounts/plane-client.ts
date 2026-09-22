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
 * (`signPlaneRequest`). A failed call is classified by `classifyPlaneCallFailure`:
 * an `execute` that may have reached the plane is `outcome_unknown` (it may have
 * run upstream — never report "nothing was sent"); only a provably unreached
 * plane is `plane_unavailable`. Never a thrown error a route turns into a 500.
 */
import { createHash, createHmac } from 'node:crypto';
import type { DeleteResult, PutResult, RevokeResult } from './store/store-adapter';
import type { HttpExecutionResult } from './executor/decide-execution-result';
import type { PlaneDeleteBody, PlaneExecuteBody, PlanePutBody, PlaneRevokeBody } from './executor/plane-wire';
import { PLANE_ROUTES } from './executor/plane-wire';
import { PLANE_SIGNATURE_HEADER, signPlaneRequest } from './executor/plane-request-signature';
import { classifyPlaneCallFailure, type PlaneCallFailure, type PlaneRoute } from './classify-plane-call-failure';

export const PLANE_URL_VAR = 'AGENT_ACCOUNTS_PLANE_URL';
export const PLANE_SERVICE_SECRET_VAR = 'AGENT_ACCOUNTS_PLANE_SERVICE_SECRET';

export type PlaneUnavailable = { readonly ok: false; readonly reason: 'plane_unavailable' };

export type PlaneClient = {
  readonly put: (body: PlanePutBody) => Promise<PutResult | PlaneUnavailable>;
  readonly revoke: (body: PlaneRevokeBody) => Promise<RevokeResult | PlaneUnavailable>;
  /** Erase the material wherever it is — used for an account whose first put never committed. */
  readonly delete: (body: PlaneDeleteBody) => Promise<DeleteResult | PlaneUnavailable>;
  readonly execute: (body: PlaneExecuteBody) => Promise<HttpExecutionResult | PlaneUnavailable>;
};

const hmac = (key: string, text: string) => createHmac('sha256', key).update(text).digest('hex');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function createPlaneClient({
  baseUrl,
  secret,
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 60_000,
}: {
  readonly baseUrl: string;
  readonly secret: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}): PlaneClient {
  const failed = (route: PlaneRoute, failure: PlaneCallFailure) => {
    const reason = classifyPlaneCallFailure({ route, failure });
    return { ok: false as const, reason };
  };

  async function call<T>(route: PlaneRoute, path: string, body: unknown): Promise<T | ReturnType<typeof failed>> {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const header = signPlaneRequest({ method: 'POST', path, body: bytes, secret, now: now(), hmac, sha256 });
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PLANE_SIGNATURE_HEADER]: header },
        body: bytes,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) return failed(route, { kind: 'status', status: response.status });
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return failed(route, { kind: 'timeout' });
      const code = (error as { cause?: { code?: unknown } }).cause?.code ?? (error as { code?: unknown }).code;
      return failed(route, { kind: 'network', code: typeof code === 'string' ? code : null });
    }
  }

  return {
    put: (body) => call<PutResult>('put', PLANE_ROUTES.put, body) as Promise<PutResult | PlaneUnavailable>,
    revoke: (body) => call<RevokeResult>('revoke', PLANE_ROUTES.revoke, body) as Promise<RevokeResult | PlaneUnavailable>,
    delete: (body) => call<DeleteResult>('delete', PLANE_ROUTES.delete, body) as Promise<DeleteResult | PlaneUnavailable>,
    execute: (body) => call<HttpExecutionResult>('execute', PLANE_ROUTES.execute, body) as Promise<HttpExecutionResult | PlaneUnavailable>,
  };
}
