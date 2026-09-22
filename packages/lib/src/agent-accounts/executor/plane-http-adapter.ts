/**
 * `createPlaneRequestHandler` — the credential plane's HTTP listener (L2·G2),
 * a Node `(req, res)` handler. I/O only: it authenticates the web process's
 * service signature (`decidePlaneRequestSignature`), parses the route's wire
 * shape (`plane-wire.ts`) and calls exactly one plane operation:
 *
 * - `put` (ingress): provisions the tenant's project + identity on first use
 *   (D-29) and writes the material under the ingress role. The only request
 *   that carries plaintext, inbound; the response carries a version, never
 *   material.
 * - `revoke` (manage): broker-denies the ref; nothing at the provider changes.
 * - `execute` (http-executor): hands the signed grant and the request to the
 *   HTTP executor, which verifies the grant itself — the service signature
 *   authenticates the caller, it grants nothing.
 *
 * Bodies are capped; anything unexpected is a 4xx with a fixed error word, never
 * an echo of the input. The web process never imports this module.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TenantId } from '@pagespace/db/schema/agent-accounts';
import type { PlaneBindings, PlaneConsenters, PlaneScope, SecretRef, StoreAdapter } from '../store/store-adapter';
import type { TenantProvisioner } from '../store/infisical-tenant-provisioner-client';
import type { AgentPageId, ConversationId, RunId, SessionId, UserId } from '../grant';
import type { HttpRequestExecutor } from './http-request-executor';
import { decidePlaneRequestSignature, PLANE_SIGNATURE_HEADER } from './plane-request-signature';
import { PLANE_ROUTES, planeExecuteBody, planePutBody, planeRevokeBody } from './plane-wire';

const MAX_BODY_BYTES = 1_500_000;

export type PlaneRequestHandlerDeps = {
  readonly secret: string;
  readonly store: Pick<StoreAdapter, 'put' | 'revoke'>;
  readonly provisioner: Pick<TenantProvisioner, 'ensureTenant' | 'identityOf'>;
  readonly executor: HttpRequestExecutor;
  readonly hmac: (key: string, text: string) => string;
  readonly sha256: (bytes: Uint8Array) => string;
  readonly now: () => number;
};

function readBody(req: IncomingMessage): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', () => resolve(null));
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

export function createPlaneRequestHandler(deps: PlaneRequestHandlerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method !== 'POST' || !Object.values(PLANE_ROUTES).includes(path as never)) return send(res, 404, { error: 'not_found' });
    const body = await readBody(req);
    if (body === null) return send(res, 413, { error: 'too_large' });
    const header = req.headers[PLANE_SIGNATURE_HEADER];
    const signature = decidePlaneRequestSignature({ header: typeof header === 'string' ? header : null, method: 'POST', path, body, secret: deps.secret, now: deps.now(), hmac: deps.hmac, sha256: deps.sha256 });
    if (!signature.ok) return send(res, 401, { error: 'unauthenticated' });
    const json = parseJson(body);

    if (path === PLANE_ROUTES.put) {
      const parsed = planePutBody.safeParse(json);
      if (!parsed.success) return send(res, 400, { error: 'malformed' });
      const { ref, material, bindings, scope, consenters } = parsed.data;
      const tenant = await deps.provisioner.ensureTenant(ref.tenantId as TenantId);
      if (tenant === null) return send(res, 503, { ok: false, reason: 'store_unavailable' });
      const result = await deps.store.put({
        ref: ref as SecretRef,
        material,
        expectedVersion: null,
        bindings: bindings as unknown as PlaneBindings,
        scope: scope as unknown as PlaneScope,
        consenters: consenters as PlaneConsenters,
        identity: { tenantId: ref.tenantId as TenantId, identityId: tenant.identityId, channel: 'ingress', blastRadius: 'tenant' },
      });
      return send(res, 200, result);
    }

    if (path === PLANE_ROUTES.revoke) {
      const parsed = planeRevokeBody.safeParse(json);
      if (!parsed.success) return send(res, 400, { error: 'malformed' });
      const { ref } = parsed.data;
      const tenant = await deps.provisioner.identityOf(ref.tenantId as TenantId);
      if (tenant === null) return send(res, 200, { ok: false, reason: 'not_found' });
      const result = await deps.store.revoke({ ref: ref as SecretRef, reason: 'owner_revoked', identity: { tenantId: ref.tenantId as TenantId, identityId: tenant.identityId, channel: 'manage', blastRadius: 'tenant' } });
      return send(res, 200, result);
    }

    const parsed = planeExecuteBody.safeParse(json);
    if (!parsed.success) return send(res, 400, { error: 'malformed' });
    const { grant, signature: grantSignature, request, run } = parsed.data;
    const result = await deps.executor.execute({
      grant,
      signature: grantSignature,
      request: { channel: 'http-executor', method: request.method, url: request.url, headers: request.headers, body: new Uint8Array(Buffer.from(request.bodyBase64, 'base64')) },
      run: {
        human: { userId: run.human.userId as UserId, sessionId: run.human.sessionId as SessionId | null },
        agentPageId: run.agentPageId as AgentPageId | null,
        conversationId: run.conversationId as ConversationId,
        runId: run.runId as RunId,
      },
    });
    return send(res, 200, result);
  }

  return (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'internal' });
      else res.end();
    });
  };
}
