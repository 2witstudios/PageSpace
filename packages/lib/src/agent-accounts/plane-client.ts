/**
 * `createPlaneClient` — how the web process reaches the credential plane
 * (L2·G2; ADR 0005 §3.4). I/O only.
 *
 * The web process holds NO store identity, no plane metadata access and no
 * write-digest key: it holds the plane's URL and service secret, and can ask
 * for: store this material (`put`, write-only), deny or erase this account
 * (`revoke`, `delete`), read its bindings' version and consenters
 * (`describe`, metadata only), rewrite its bindings (`rebind` — a widening is
 * refused by the plane unless it carries an `OwnerConsent`), read its policy
 * window's usage (`usage`), and run a request under a signed grant
 * (`execute`). It can never ask for material back: there is no such route.
 *
 * Every call is signed over method, path, body digest and time
 * (`signPlaneRequest`). A failed call is classified by `classifyPlaneCallFailure`:
 * an `execute` that may have reached the plane is `outcome_unknown` (it may have
 * run upstream — never report "nothing was sent"); only a provably unreached
 * plane is `plane_unavailable`. Never a thrown error a route turns into a 500.
 */
import { createHash, createHmac } from 'node:crypto';
import type { DeleteResult, PutResult, RebindResult, RevokeResult } from './store/store-adapter';
import type { HttpExecutionResult } from './executor/decide-execution-result';
import type {
  PlaneDeleteBody,
  PlaneDescribeBody,
  PlaneDescribeResult,
  PlaneExecuteBody,
  PlaneOAuthExchangeBody,
  PlaneOAuthExchangeResult,
  PlanePutBody,
  PlaneRebindBody,
  PlaneRevokeBody,
  PlaneUsageBody,
  PlaneUsageResult,
} from './executor/plane-wire';
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
  readonly describe: (body: PlaneDescribeBody) => Promise<PlaneDescribeResult | PlaneUnavailable>;
  /** An uncertain failure (`plane_unavailable`) may still have applied: re-`describe` before retrying. */
  readonly rebind: (body: PlaneRebindBody) => Promise<RebindResult | PlaneUnavailable>;
  readonly usage: (body: PlaneUsageBody) => Promise<PlaneUsageResult | PlaneUnavailable>;
  /** Connect an OAuth account: the plane exchanges the code and stores the tokens; only a version and the account's email come back. */
  readonly oauthExchange: (body: PlaneOAuthExchangeBody) => Promise<PlaneOAuthExchangeResult | PlaneUnavailable>;
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
    describe: (body) => call<PlaneDescribeResult>('describe', PLANE_ROUTES.describe, body) as Promise<PlaneDescribeResult | PlaneUnavailable>,
    rebind: (body) => call<RebindResult>('rebind', PLANE_ROUTES.rebind, body) as Promise<RebindResult | PlaneUnavailable>,
    usage: (body) => call<PlaneUsageResult>('usage', PLANE_ROUTES.usage, body) as Promise<PlaneUsageResult | PlaneUnavailable>,
    oauthExchange: (body) => call<PlaneOAuthExchangeResult>('oauthExchange', PLANE_ROUTES.oauthExchange, body) as Promise<PlaneOAuthExchangeResult | PlaneUnavailable>,
    execute: (body) => call<HttpExecutionResult>('execute', PLANE_ROUTES.execute, body) as Promise<HttpExecutionResult | PlaneUnavailable>,
  };
}
