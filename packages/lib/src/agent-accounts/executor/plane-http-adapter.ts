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
 * - `describe` (manage): the stored bindings' policy version, consenters and
 *   revocation — metadata the authority needs to CAS a rebind; never material.
 * - `rebind` (manage): rewrites the bindings. The STORE decides, against its
 *   own stored scope, whether the change narrows (no consent) or widens (an
 *   `OwnerConsent` from a pinned consenter, signed under the consent key and
 *   consumed single-use) — the service signature authorizes nothing here.
 * - `usage` (manage): the policy window's counters from the plane's ledger.
 * - `oauthExchange` (ingress): connects an OAuth account — exchanges the code
 *   at the PINNED token endpoint with the plane's own client, checks the id
 *   token, and `put`s the tokens. The response names the account and the
 *   granted scopes; no token ever leaves.
 * - `execute` (http-executor): hands the signed grant and the request to the
 *   HTTP executor, which verifies the grant itself — the service signature
 *   authenticates the caller, it grants nothing.
 *
 * Bodies are capped; anything unexpected is a 4xx with a fixed error word, never
 * an echo of the input. The web process never imports this module.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TenantId } from '@pagespace/db/schema/agent-accounts';
import type { OwnerConsent, PlaneBindings, PlaneConsenters, PlaneScope, SecretRef, StoreAdapter } from '../store/store-adapter';
import type { UsageLedger } from '../store/usage-ledger-repository';
import type { PolicyVersion } from '@pagespace/db/schema/agent-accounts';
import type { TenantProvisioner } from '../store/infisical-tenant-provisioner-client';
import type { AgentPageId, ConversationId, RunId, SessionId, UserId } from '../grant';
import type { HttpRequestExecutor } from './http-request-executor';
import { decidePlaneRequestSignature, PLANE_SIGNATURE_HEADER } from './plane-request-signature';
import { PLANE_ROUTES, planeDeleteBody, planeDescribeBody, planeExecuteBody, planeOAuthExchangeBody, planePutBody, planeRebindBody, planeRevokeBody, planeUsageBody, type PlaneDescribeResult, type PlaneOAuthExchangeResult, type PlaneUsageResult } from './plane-wire';
import type { PinnedHttpsClient } from './pinned-https-client';
import type { OAuthEndpointRegistry } from '../refresh/decide-refresh-endpoint';
import type { OAuthClientCredentials } from '../refresh/build-refresh-request';
import { buildTokenEndpointRequest } from '../refresh/build-refresh-request';
import { interpretTokenResponse } from '../refresh/interpret-token-response';
import { planEnrolledMaterial } from '../oauth/plan-enrolled-material';
import type { SshClient } from './ssh-client';
import { generateSshKeyPair } from './ssh-client';
import type { SshCommandExecutor } from './ssh-command-executor';
import { sshTargetOf } from '../ssh/ssh-command';
import { planeSshEnrollBody, planeSshExecBody, planeSshHostKeyBody, type PlaneSshEnrollResult, type PlaneSshHostKeyResult } from './plane-wire';

const MAX_BODY_BYTES = 1_500_000;
/** The liveness probe the image HEALTHCHECK and Fly's `[checks.health]` call. */
export const PLANE_HEALTH_PATH = '/health';

export type PlaneRequestHandlerDeps = {
  readonly secret: string;
  readonly store: Pick<StoreAdapter, 'put' | 'revoke' | 'delete' | 'describe' | 'rebind'>;
  readonly usage: Pick<UsageLedger, 'window'>;
  /** Code exchange at enrollment: the pinned endpoints, the plane's OAuth clients and its pinned HTTPS client. */
  readonly oauth: { readonly endpoints: OAuthEndpointRegistry; readonly clientFor: (providerSlug: string) => OAuthClientCredentials | null; readonly network: PinnedHttpsClient } | null;
  readonly provisioner: Pick<TenantProvisioner, 'ensureTenant' | 'identityOf'>;
  readonly executor: HttpRequestExecutor;
  /** SSH accounts (slice 5): the transport for host-key probes and the command executor; null = SSH is off. */
  readonly ssh: { readonly client: Pick<SshClient, 'hostKey'>; readonly executor: SshCommandExecutor } | null;
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
    // Liveness for the platform's probe: unauthenticated, GET-only, and it says nothing beyond "up".
    if (req.method === 'GET' && path === PLANE_HEALTH_PATH) return send(res, 200, { ok: true });
    if (req.method !== 'POST'|| !Object.values(PLANE_ROUTES).includes(path as never)) return send(res, 404, { error: 'not_found' });
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

    if (path === PLANE_ROUTES.delete) {
      const parsed = planeDeleteBody.safeParse(json);
      if (!parsed.success) return send(res, 400, { error: 'malformed' });
      const { ref } = parsed.data;
      const tenant = await deps.provisioner.identityOf(ref.tenantId as TenantId);
      // No tenant project was ever created: nothing of this account can be in the vault.
      if (tenant === null) return send(res, 200, { ok: true, removed: true, upstream: 'not_attempted' });
      const result = await deps.store.delete({ ref: ref as SecretRef, upstream: 'not_attempted', identity: { tenantId: ref.tenantId as TenantId, identityId: tenant.identityId, channel: 'manage', blastRadius: 'tenant' } });
      return send(res, 200, result.ok || result.reason === 'not_found' ? { ok: true, removed: true, upstream: 'not_attempted' } : result);
    }

    if (path === PLANE_ROUTES.describe) {
      const parsed = planeDescribeBody.safeParse(json);
      if (!parsed.success) return send(res, 400, { error: 'malformed' });
      const { ref } = parsed.data;
      const tenant = await deps.provisioner.identityOf(ref.tenantId as TenantId);
      if (tenant === null) return send(res, 200, { ok: false, reason: 'not_found' } satisfies PlaneDescribeResult);
      const described = await deps.store.describe({ ref: ref as SecretRef, identity: { tenantId: ref.tenantId as TenantId, identityId: tenant.identityId, channel: 'manage', blastRadius: 'tenant' } });
      const result: PlaneDescribeResult = described.ok
        ? { ok: true, policyVersion: described.bindings.policyVersion, consenters: described.consenters, revoked: described.revokedAt !== null }
        : { ok: false, reason: described.reason };
      return send(res, 200, result);
    }

    if (path === PLANE_ROUTES.rebind) {
      const parsed = planeRebindBody.safeParse(json);
      if (!parsed.success) return send(res, 400, { error: 'malformed' });
      const { ref, expectedVersion, bindings, scope, consenters, consent } = parsed.data;
      const tenant = await deps.provisioner.identityOf(ref.tenantId as TenantId);
      if (tenant === null) return send(res, 200, { ok: false, reason: 'not_found' });
      const result = await deps.store.rebind({
        ref: ref as SecretRef,
        expectedVersion: expectedVersion as PolicyVersion,
        bindings: bindings as unknown as PlaneBindings,
        scope: scope as unknown as PlaneScope,
        consenters: consenters as PlaneConsenters,
        consent: consent as OwnerConsent | null,
        identity: { tenantId: ref.tenantId as TenantId, identityId: tenant.identityId, channel: 'manage', blastRadius: 'tenant' },
      });
      return send(res, 200, result);
    }

    if (path === PLANE_ROUTES.oauthExchange) {
      const parsed = planeOAuthExchangeBody.safeParse(json);
      if (!parsed.success) return send(res, 400, { error: 'malformed' });
      const { ref, providerSlug, code, codeVerifier, redirectUri, requestedScopes, bindings, scope, consenters } = parsed.data;
      const refuse = (reason: Extract<PlaneOAuthExchangeResult, { readonly ok: false }>['reason']) => send(res, 200, { ok: false, reason } satisfies PlaneOAuthExchangeResult);
      const endpoint = deps.oauth === null || !Object.prototype.hasOwnProperty.call(deps.oauth.endpoints, providerSlug) ? undefined : deps.oauth.endpoints[providerSlug];
      const client = deps.oauth?.clientFor(providerSlug) ?? null;
      if (deps.oauth === null || endpoint === undefined || client === null) return refuse('not_configured');
      const built = buildTokenEndpointRequest({
        tokenEndpoint: endpoint.tokenEndpoint,
        clientAuth: endpoint.clientAuth,
        client,
        grant: [['grant_type', 'authorization_code'], ['code', code], ['code_verifier', codeVerifier], ['redirect_uri', redirectUri]],
      });
      if (!built.ok) return refuse('exchange_failed');
      const reading = interpretTokenResponse({ send: await deps.oauth.network.send(built.request), now: deps.now() });
      if (!reading.ok) return refuse(reading.failure.kind === 'status' && reading.failure.status >= 400 && reading.failure.status < 500 ? 'exchange_refused' : 'exchange_failed');
      const planned = planEnrolledMaterial({ body: reading.body, endpoint, clientId: client.clientId, requestedScopes, now: deps.now() });
      if (!planned.ok) return refuse(planned.reason);
      const tenant = await deps.provisioner.ensureTenant(ref.tenantId as TenantId);
      if (tenant === null) return refuse('store_unavailable');
      const put = await deps.store.put({
        ref: ref as SecretRef,
        material: { kind: 'oauth2', material: planned.material },
        expectedVersion: null,
        bindings: bindings as unknown as PlaneBindings,
        scope: scope as unknown as PlaneScope,
        consenters: consenters as PlaneConsenters,
        identity: { tenantId: ref.tenantId as TenantId, identityId: tenant.identityId, channel: 'ingress', blastRadius: 'tenant' },
      });
      return send(res, 200, (put.ok ? { ok: true, version: put.version, email: planned.email, scopes: planned.material.scopes } : { ok: false, reason: put.reason }) satisfies PlaneOAuthExchangeResult);
    }

    if (path === PLANE_ROUTES.sshHostKey) {
      const parsed = planeSshHostKeyBody.safeParse(json);
      if (!parsed.success) return send(res, 400, { error: 'malformed' });
      if (deps.ssh === null) return send(res, 404, { error: 'not_found' });
      const probed = await deps.ssh.client.hostKey(parsed.data);
      return send(res, 200, probed satisfies PlaneSshHostKeyResult);
    }

    if (path === PLANE_ROUTES.sshEnroll) {
      const parsed = planeSshEnrollBody.safeParse(json);
      if (!parsed.success) return send(res, 400, { error: 'malformed' });
      if (deps.ssh === null) return send(res, 404, { error: 'not_found' });
      const { ref, username, hostKeySha256, bindings, scope, consenters } = parsed.data;
      // Exactly one pinned ssh:// target in the bindings being stored, or nothing is created.
      const origins = (bindings as { allowedOrigins?: unknown }).allowedOrigins;
      if (!Array.isArray(origins) || origins.length !== 1 || typeof origins[0] !== 'string' || sshTargetOf(origins[0]) === null) return send(res, 200, { ok: false, reason: 'target_invalid' } satisfies PlaneSshEnrollResult);
      const tenant = await deps.provisioner.ensureTenant(ref.tenantId as TenantId);
      if (tenant === null) return send(res, 200, { ok: false, reason: 'store_unavailable' } satisfies PlaneSshEnrollResult);
      const pair = generateSshKeyPair(`pagespace-agent-${ref.accountId}`);
      const put = await deps.store.put({
        ref: ref as SecretRef,
        material: { kind: 'ssh_key', material: { privateKey: pair.privateKey, publicKey: pair.publicKey, username, hostKeySha256 } },
        expectedVersion: null,
        bindings: bindings as unknown as PlaneBindings,
        scope: scope as unknown as PlaneScope,
        consenters: consenters as PlaneConsenters,
        identity: { tenantId: ref.tenantId as TenantId, identityId: tenant.identityId, channel: 'ingress', blastRadius: 'tenant' },
      });
      return send(res, 200, (put.ok ? { ok: true, version: put.version, publicKey: pair.publicKey } : { ok: false, reason: put.reason }) satisfies PlaneSshEnrollResult);
    }

    if (path === PLANE_ROUTES.sshExec) {
      const parsed = planeSshExecBody.safeParse(json);
      if (!parsed.success) return send(res, 400, { error: 'malformed' });
      if (deps.ssh === null) return send(res, 404, { error: 'not_found' });
      const { grant, signature: grantSignature, command, stdin, run } = parsed.data;
      const result = await deps.ssh.executor.execute({
        grant,
        signature: grantSignature,
        command,
        stdin,
        run: {
          human: { userId: run.human.userId as UserId, sessionId: run.human.sessionId as SessionId | null },
          agentPageId: run.agentPageId as AgentPageId | null,
          conversationId: run.conversationId as ConversationId,
          runId: run.runId as RunId,
        },
      });
      return send(res, 200, result);
    }

    if (path === PLANE_ROUTES.usage) {
      const parsed = planeUsageBody.safeParse(json);
      if (!parsed.success) return send(res, 400, { error: 'malformed' });
      const window = await deps.usage.window({ ref: parsed.data.ref as SecretRef, now: deps.now() }).catch(() => null);
      const result: PlaneUsageResult = window === null ? { ok: false, reason: 'store_unavailable' } : { ok: true, ...window };
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
    handle(req, res).catch((error: unknown) => {
      // Route and error class only: a message can carry request bytes, and this process holds plaintext.
      const route = (req.url ?? '').split('?')[0] ?? '';
      process.stderr.write(`credential-plane: internal error on ${route.slice(0, 64)}: ${error instanceof Error ? error.name : 'unknown'}\n`);
      if (!res.headersSent) send(res, 500, { error: 'internal' });
      else res.end();
    });
  };
}
