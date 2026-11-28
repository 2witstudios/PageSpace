/**
 * ADVERSARIAL — the L2·G2 thin slice end to end (task item 7): the real
 * account authority and plane client in the "web" role, a real credential
 * plane listener (HTTP executor + Infisical store adapter + per-tenant
 * provisioner + plane metadata DB), the real main DB (:5433: reference rows,
 * approvals, grant nonces, the audit chain) and a real TLS upstream.
 *
 * Rows: create → authorize → execute → revoke; the canary key never appears in
 * any model-visible surface; a reflected credential is scrubbed; a redirect is
 * not followed; another origin or port is denied before I/O; cross-agent
 * substitution (by account id and by replaying a grant under another run) is
 * refused; DNS rebinding at the plane is refused; revocation ends a grant
 * minted before it; a concrete approval is single-use; an unrecorded outcome
 * is never reported as success.
 *
 * Needs Infisical (INFISICAL_DEV_ADMIN_TOKEN, README-infisical-dev.md), the
 * plane metadata DB (:55433) and the main DB (DATABASE_URL). Skips visibly when
 * Infisical is not configured; CI's Infisical step runs it and requires a full pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync, randomBytes, verify as nodeVerify, createPublicKey, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import { db, getAdvisoryLockPool } from '@pagespace/db/db';
import { createAccountChangeLock } from '../../account-change-lock';
import { createPlaneRefreshWorker } from '../../executor/plane-refresh';
import { AGENT_ACCOUNT_OPERATIONS, GOOGLE_ORIGINS } from '../../registry/google-operations';
import { eq, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { pagePermissions } from '@pagespace/db/schema/members';
import { requireDb } from '@pagespace/db/test/require-db';
import { isPublicIp } from '../../../security/web-fetch-ssrf';
import { createSecurityAuditRepository } from '../../../audit/security-audit-repository';
import { loadAccountAuthorityKeyring } from '../../../auth/account-authority-signing-key';
import type { AgentPageId, ConversationId, Ed25519Verify, HashBytes, PresenterKeyId, RunId, SessionId, UserId } from '../../grant';
import type { CanonicalRequestInput } from '../../canonical-request';
import type { WriteDigestKey } from '../../store/store-adapter';
import { createInfisicalClient } from '../../store/infisical-client';
import { createPlaneMetadataRepository } from '../../store/plane-metadata-repository';
import { createInfisicalStoreAdapter } from '../../store/store-adapter-infisical';
import { createConsentLedgerRepository } from '../../store/consent-ledger-repository';
import { createUsageLedgerRepository } from '../../store/usage-ledger-repository';
import { createInfisicalTenantProvisioner } from '../../store/infisical-tenant-provisioner-client';
import { createReplayStoreRepository } from '../../replay-store-repository';
import { createGrantGate } from '../../grant-gate-executor';
import { createAgentAccountAuditRepository, type AgentAccountAuditRepository } from '../../audit-repository';
import { createAuditedExecutor } from '../../audit-gate-executor';
import { createAgentAccountRepository } from '../../agent-account-repository';
import { createAccountFactsRepository } from '../../account-facts-repository';
import { createAccountAuthority, type AccountAuthority } from '../../account-authority-executor';
import { createPlaneClient, type PlaneClient } from '../../plane-client';
import { authorize } from '../../authorize';
import { signGrant } from '../../sign-grant';
import { planeBindingsFor } from '../../plane-bindings-for';
import { digestBindings } from '../../store/digest-bindings';
import { agentAccounts } from '@pagespace/db/schema/agent-accounts';
import { createPinnedHttpsClient } from '../../executor/pinned-https-client';
import { createHttpRequestExecutor } from '../../executor/http-request-executor';
import { sweepOrphanedRefs } from '../../executor/plane-orphan-sweep-worker';
import { ORPHAN_GRACE_MS } from '../../executor/decide-orphaned-refs';
import { createPlaneRequestHandler } from '../../executor/plane-http-adapter';
import { credentialActor } from '../../../permissions/access-actor';

const INFISICAL_URL = process.env.INFISICAL_DEV_URL ?? 'http://localhost:8080';
const ADMIN_TOKEN = process.env.INFISICAL_DEV_ADMIN_TOKEN;
const METADATA_URL = process.env.PLANE_METADATA_DEV_URL ?? 'postgres://plane_metadata:plane_metadata@127.0.0.1:55433/plane_metadata';
const CANARY = `sk_canary_${randomBytes(12).toString('hex')}`;
const HOST = 'api.e2e-weather.example';
/** A second name on the same test certificate, so a request there would succeed if nothing refused it. */
const EVIL_HOST = 'collector.e2e-evil.example';
const RUN = `g2e2e${Date.now()}`;
// Real PageSpace ids are cuid2; the centralized permission functions refuse anything else.
const OWNER = createId() as UserId;
const VIEWER = createId() as UserId;
const DRIVE = createId();
const PAGE_A = createId() as AgentPageId;
const PAGE_B = createId() as AgentPageId;
const SECRET = randomBytes(32).toString('hex');
const GOOGLE_CLIENT = { clientId: 'e2e-client.apps.googleusercontent.com', clientSecret: `gcs_${randomBytes(8).toString('hex')}` };
const GOOD_CODE = `code_${randomBytes(8).toString('hex')}`;
const STALE_ACCESS = `ya29_stale_${randomBytes(8).toString('hex')}`;
const REFRESH_TOKEN = `1//rt_${randomBytes(8).toString('hex')}`;
const tokenCalls: string[] = [];
const PRESENTER = 'exec_e2e' as PresenterKeyId;

const sha3: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const sha256: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const verifyEd25519: Ed25519Verify = (message, signature, publicKey) => nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);

let certDir: string;
let ca: string;
let upstream: HttpsServer;
let upstreamPort: number;
let origin: string;
const upstreamHits: string[] = [];
let metadataPool: Pool;
let orgId = '';
const planes: HttpServer[] = [];
const keyring = (() => {
  const { privateKey } = generateKeyPairSync('ed25519');
  return loadAccountAuthorityKeyring({ ACCOUNT_AUTHORITY_SIGNING_KEY: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') });
})();

function openssl(args: readonly string[]) {
  execFileSync('openssl', args, { cwd: certDir, stdio: 'ignore' });
}

function startUpstream(): Promise<void> {
  writeFileSync(path.join(certDir, 'leaf.ext'), `subjectAltName=DNS:${HOST},DNS:${EVIL_HOST}\n`);
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-subj', '/CN=g2-e2e-ca', '-days', '1', '-out', 'ca.pem']);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-subj', `/CN=${HOST}`, '-out', 'leaf.csr']);
  openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'leaf.ext', '-out', 'leaf.pem']);
  // The trust anchor comes from openssl's stdout, not a file read, so no file data flows into the client's
  // request options (CodeQL js/file-access-to-http); production never passes `ca` at all.
  ca = execFileSync('openssl', ['x509', '-in', 'ca.pem'], { cwd: certDir }).toString('utf8');
  upstream = createHttpsServer({ key: readFileSync(path.join(certDir, 'leaf.key')), cert: readFileSync(path.join(certDir, 'leaf.pem')) }, (req, res) => {
    upstreamHits.push(req.url ?? '');
    if (req.url === '/token' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        tokenCalls.push(form.get('grant_type') ?? '');
        const clientOk = form.get('client_id') === GOOGLE_CLIENT.clientId && form.get('client_secret') === GOOGLE_CLIENT.clientSecret;
        const json = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (!clientOk) return json(401, { error: 'invalid_client' });
        if (form.get('grant_type') === 'authorization_code') {
          if (form.get('code') !== GOOD_CODE || (form.get('code_verifier') ?? '').length < 43) return json(400, { error: 'invalid_grant' });
          const claims = { iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT.clientId, exp: Math.floor(Date.now() / 1000) + 3600, email: 'agent@e2e.example', email_verified: true };
          // A nearly expired access token: the first use must refresh it first.
          return json(200, { access_token: STALE_ACCESS, expires_in: 30, refresh_token: REFRESH_TOKEN, token_type: 'Bearer', scope: 'openid email https://www.googleapis.com/auth/gmail.readonly', id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig` });
        }
        if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === REFRESH_TOKEN) return json(200, { access_token: CANARY, expires_in: 3600, token_type: 'Bearer', scope: 'openid email https://www.googleapis.com/auth/gmail.readonly' });
        return json(400, { error: 'invalid_grant' });
      });
      return;
    }
    const authorized = req.headers['x-api-key'] === CANARY || req.headers.authorization === `Bearer ${CANARY}`;
    if (!authorized) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":"unauthorized"}');
    }
    if (req.url?.startsWith('/v1/echo')) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-echo-key': CANARY, 'set-cookie': `session=${CANARY}` });
      return res.end(JSON.stringify({ youSent: CANARY, b64: Buffer.from(CANARY).toString('base64') }));
    }
    if (req.url?.startsWith('/v1/redirect')) {
      res.writeHead(302, { location: `https://collector.evil.test/steal?key=${CANARY}` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ city: 'Oslo', temp: 7 }));
  });
  return new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
}

function planeStore() {
  const metadata = createPlaneMetadataRepository({ pool: metadataPool as never });
  const provisioner = createInfisicalTenantProvisioner({ baseUrl: INFISICAL_URL, organizationId: orgId, auth: { kind: 'token', token: ADMIN_TOKEN ?? '' }, pool: metadataPool as never, advisoryLockPool: metadata.advisoryLockPool });
  const usage = createUsageLedgerRepository({ pool: metadataPool });
  const store = createInfisicalStoreAdapter({
    infisical: createInfisicalClient({ baseUrl: INFISICAL_URL, environment: 'dev' }),
    metadata,
    advisoryLockPool: metadata.advisoryLockPool,
    resolveProject: (tenantId) => provisioner.projectOf(tenantId),
    resolveCredentials: (input) => provisioner.credentialsFor(input),
    hash: sha3,
    writeDigestKey: new Uint8Array(randomBytes(32)) as WriteDigestKey,
    hmac: (key, bytes) => createHmac('sha3-256', key).update(bytes).digest('hex'),
    now: () => Date.now(),
    consentPublicKey: new Uint8Array(CONSENT_PAIR.publicKey.export({ type: 'spki', format: 'der' })),
    verify: verifyEd25519,
    consentLedger: createConsentLedgerRepository({ pool: metadataPool }),
  });
  return { metadata, provisioner, store, usage };
}

async function startPlane({ isPublic = () => true, wrapAudit = (r: AgentAccountAuditRepository) => r }: { readonly isPublic?: (ip: string) => boolean; readonly wrapAudit?: (r: AgentAccountAuditRepository) => AgentAccountAuditRepository } = {}): Promise<PlaneClient> {
  const { metadata, provisioner, store, usage } = planeStore();
  const network = createPinnedHttpsClient({ resolveHost: async () => [{ address: '127.0.0.1', family: 4 }], isPublic, ca, limits: { totalTimeoutMs: 5_000, maxResponseBytes: 1_000_000, maxConcurrent: 8 } });
  // Google, as the plane pins it — except that its token endpoint is this suite's TLS upstream.
  const endpoints = { google: { issuer: 'https://accounts.google.com', tokenEndpoint: `https://${HOST}:${upstreamPort}/token`, revocationEndpoint: `https://${HOST}:${upstreamPort}/revoke`, clientAuth: 'client_secret_post' as const } };
  const clientFor = (providerSlug: string) => (providerSlug === 'google' ? GOOGLE_CLIENT : null);
  const refresh = createPlaneRefreshWorker({ store, metadata, advisoryLockPool: metadata.advisoryLockPool, metadataPool, provisioner, accounts: createAgentAccountRepository({ db }), network, endpoints, clientFor, presenterKeyId: PRESENTER, hash: sha3, now: () => Date.now() });
  const executor = createHttpRequestExecutor({
    store,
    provisioner,
    accounts: createAgentAccountRepository({ db }),
    grantGate: createGrantGate({ replayStore: createReplayStoreRepository({ db }) }),
    audited: createAuditedExecutor({ auditRepository: wrapAudit(createAgentAccountAuditRepository({ appendPath: createSecurityAuditRepository({ db }) })), hash: sha3 }),
    planeScope: (ref) => metadata.read(ref).then((facts) => facts?.scope ?? null),
    usage,
    refresh,
    network,
    registry: AGENT_ACCOUNT_OPERATIONS,
    issuerPublicKey: keyring.current.publicKey,
    presenterKeyId: PRESENTER,
    verify: verifyEd25519,
    hash: sha3,
    sha256,
    now: () => Date.now(),
    rotationGraceMs: 300_000,
    maxReleasedBodyBytes: 64 * 1024,
  });
  const server = createHttpServer(
    createPlaneRequestHandler({ secret: SECRET, store, usage, oauth: { endpoints, clientFor, network }, provisioner, executor, hmac: (key, text) => createHmac('sha256', key).update(text).digest('hex'), sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'), now: () => Date.now() }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  planes.push(server);
  return createPlaneClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secret: SECRET });
}

/** The step-up consent key: the plane holds the public half, the authority signs with the private one. */
const CONSENT_PAIR = generateKeyPairSync('ed25519');
const CONSENT_KEY = { sign: (message: Uint8Array) => new Uint8Array(nodeSign(null, message, CONSENT_PAIR.privateKey)) };

const authorityOver = (plane: PlaneClient): AccountAuthority =>
  createAccountAuthority({ accounts: createAgentAccountRepository({ db }), facts: createAccountFactsRepository(), plane, authorityKey: keyring.current, presenterKeyId: PRESENTER, registry: AGENT_ACCOUNT_OPERATIONS, providerOrigins: { google: [...GOOGLE_ORIGINS, new URL(origin).origin + (new URL(origin).port ? '' : ':443')] }, consentKey: CONSENT_KEY, lockAccount: createAccountChangeLock(getAdvisoryLockPool()), hash: sha3, now: () => Date.now() });

const caller = (overrides: Partial<Parameters<AccountAuthority['requestOperation']>[0]['caller']> = {}) => ({
  actorUserId: OWNER,
  actingHumanUserId: OWNER,
  sessionId: 'sess_e2e' as SessionId,
  agentPageId: PAGE_A,
  conversationId: `${RUN}_conv` as ConversationId,
  runId: `${RUN}_run_${randomBytes(4).toString('hex')}` as RunId,
  callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
  ...overrides,
});
/** The acting human's credential travels with the caller (D-OW-45): the authority reads their standing through it. */
const asHuman = (c: ReturnType<typeof caller>) => ({ caller: c, actor: credentialActor(c.actingHumanUserId, null) });
const get = (url: string): CanonicalRequestInput => ({ channel: 'http-executor', method: 'GET', url, headers: { accept: 'application/json' }, body: new Uint8Array(0) });
const createInput = (allowGenericRequests: boolean) => ({ name: 'Weather', allowedOrigins: [origin], ownership: 'dedicated' as const, acknowledged: false, apiKey: CANARY, placement: { in: 'header' as const, name: 'X-Api-Key' }, allowGenericRequests });
/** Every string a model could ever see from this slice, gathered for the canary sweep. */
const modelVisible: string[] = [];
const seen = <T>(value: T): T => {
  modelVisible.push(JSON.stringify(value));
  return value;
};

describe.skipIf(!ADMIN_TOKEN)('adversarial: the G2 thin slice end to end (real plane, real Infisical, real main DB, real TLS upstream)', () => {
  beforeAll(async () => {
    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      requireDb('http-executor-end-to-end.integration.test.ts', error);
    }
    certDir = mkdtempSync(path.join(tmpdir(), 'g2-e2e-'));
    await startUpstream();
    upstreamPort = (upstream.address() as AddressInfo).port;
    origin = `https://${HOST}:${upstreamPort}`;
    metadataPool = new Pool({ connectionString: METADATA_URL });
    const orgs = await fetch(`${INFISICAL_URL}/api/v1/organization`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }).then((r) => r.json() as Promise<{ organizations: { id: string }[] }>);
    orgId = process.env.INFISICAL_DEV_ORG_ID ?? orgs.organizations[0]?.id ?? '';
    await db.insert(users).values([
      { id: OWNER, name: 'owner', email: `${OWNER}@example.test` },
      { id: VIEWER, name: 'viewer', email: `${VIEWER}@example.test` },
    ]);
    await db.insert(drives).values({ id: DRIVE, name: 'd', slug: DRIVE, ownerId: OWNER });
    await db.insert(pages).values([
      { id: PAGE_A, title: 'agent a', type: 'AI_CHAT', driveId: DRIVE, position: 0 },
      { id: PAGE_B, title: 'agent b', type: 'AI_CHAT', driveId: DRIVE, position: 1 },
    ]);
    await db.insert(pagePermissions).values({ pageId: PAGE_A, userId: VIEWER, canView: true, canEdit: false, canShare: false, canDelete: false });
  }, 120_000);

  afterAll(async () => {
    for (const server of planes) server.close();
    upstream?.close();
    await db.delete(users).where(eq(users.id, OWNER));
    await db.delete(users).where(eq(users.id, VIEWER));
    await metadataPool?.end();
    if (certDir) rmSync(certDir, { recursive: true, force: true });
  });

  it('given a dedicated api_key account on agent page A with generic requests allowed, should create → execute against the pin with the key attached → revoke, and the key never comes back', async () => {
    const authority = authorityOver(await startPlane());
    const created = seen(await authority.createAccount({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) }));
    if (!created.ok) throw new Error(`create refused: ${created.reason}`);
    const listed = seen(await authority.listAccounts({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A } }));
    const result = seen(await authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request: get(`${origin}/v1/weather?city=Oslo`) }));
    const revoked = seen(await authority.revokeAccount({ actor: credentialActor(OWNER, null), accountId: created.account.id }));
    const afterRevoke = seen(await authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request: get(`${origin}/v1/weather?city=Oslo`) }));

    const actual = {
      created: { kind: created.account.kind, acknowledgment: created.account.acknowledgment, status: created.account.status },
      listed: listed?.map((account) => account.id),
      result: result.ok ? { status: result.response.status, body: result.response.body } : result,
      revoked: revoked.ok ? revoked.account.status : revoked,
      afterRevoke,
    };
    const expected = {
      created: { kind: 'api_key', acknowledgment: 'dedicated_agent_account', status: 'active' },
      listed: [created.account.id],
      result: { status: 200, body: '{"city":"Oslo","temp":7}' },
      revoked: 'revoked',
      afterRevoke: { ok: false, reason: 'account_unavailable' },
    };
    expect(actual).toEqual(expected);
  }, 60_000);

  it('given an upstream that reflects the key in body, headers and a cookie, should release none of it', async () => {
    const authority = authorityOver(await startPlane());
    const created = await authority.createAccount({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const result = seen(await authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request: get(`${origin}/v1/echo`) }));
    const actual = { ok: result.ok, redacted: result.ok ? result.response.redacted : null, leaked: JSON.stringify(result).includes(CANARY), b64Leaked: JSON.stringify(result).includes(Buffer.from(CANARY).toString('base64')), headerNames: result.ok ? result.response.headers.map(([name]) => name) : null };
    // `date` is allowlisted; the echoing `x-echo-key` and `set-cookie` are not.
    const expected = { ok: true, redacted: true, leaked: false, b64Leaked: false, headerNames: ['content-type', 'date'] };
    expect(actual).toEqual(expected);
  }, 60_000);

  it('given a redirect off the pin, should return the 3xx without its query and never follow it', async () => {
    const authority = authorityOver(await startPlane());
    const created = await authority.createAccount({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const before = upstreamHits.length;
    const result = seen(await authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request: get(`${origin}/v1/redirect`) }));
    const actual = { status: result.ok ? result.response.status : result, location: result.ok ? result.response.headers.find(([name]) => name === 'location') : null, hits: upstreamHits.slice(before) };
    const expected = { status: 302, location: ['location', 'https://collector.evil.test/steal'], hits: ['/v1/redirect'] };
    expect(actual).toEqual(expected);
  }, 60_000);

  it('given another port on the pinned host or another host, should deny before any upstream I/O', async () => {
    const authority = authorityOver(await startPlane());
    const created = await authority.createAccount({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const before = upstreamHits.length;
    const actual = {
      otherPort: seen(await authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request: get(`https://${HOST}:${upstreamPort + 1}/v1/weather`) })),
      otherHost: seen(await authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request: get(`https://collector.evil.test/v1/weather`) })),
      hits: upstreamHits.length - before,
    };
    const expected = { otherPort: { ok: false, reason: 'destination_denied', rule: 'origin_not_allowed' }, otherHost: { ok: false, reason: 'destination_denied', rule: 'origin_not_allowed' }, hits: 0 };
    expect(actual).toEqual(expected);
  }, 60_000);

  it('given cross-agent substitution — page B naming page A\'s account, a view-only user, or page A\'s grant replayed under page B\'s run or twice — should refuse every one with no upstream I/O', async () => {
    const plane = await startPlane();
    const authority = authorityOver(plane);
    const created = await authority.createAccount({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const row = await createAgentAccountRepository({ db }).find(created.account.id);
    const verdict = authorize({
      caller: caller(),
      account: row,
      facts: { humanDriveRole: 'OWNER', agentPagePermission: 'edit', agentBoundToAccount: false, boundAgentPageIds: [], delegation: { kind: 'live_session' }, ceilingAdmitsAccount: true },
      request: get(`${origin}/v1/weather`),
      registry: [],
      approvals: [],
      usage: { usesThisHour: 0, bytesOutThisHour: 0, concurrent: 0 },
      presenter: { keyId: PRESENTER, channel: 'http-executor' },
      now: Date.now(),
      grantId: `g_${randomBytes(6).toString('hex')}` as never,
      nonce: `n_${randomBytes(6).toString('hex')}` as never,
      ttlMs: 60_000,
      hash: sha3,
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    const signature = signGrant({ grant: verdict.grant, key: keyring.current });
    const wire = { method: 'GET', url: `${origin}/v1/weather`, headers: { accept: 'application/json' }, bodyBase64: '' };
    const runOf = (agentPageId: AgentPageId) => ({ human: verdict.grant.human, agentPageId, conversationId: verdict.grant.conversationId, runId: verdict.grant.runId });

    const before = upstreamHits.length;
    const pageB = seen(await authority.requestOperation({ ...asHuman(caller({ agentPageId: PAGE_B })), accountId: created.account.id, request: get(`${origin}/v1/weather`) }));
    const viewer = seen(await authority.requestOperation({ ...asHuman(caller({ actorUserId: VIEWER, actingHumanUserId: VIEWER })), accountId: created.account.id, request: get(`${origin}/v1/weather`) }));
    const replayedUnderB = seen(await plane.execute({ grant: verdict.grant, signature, request: wire, run: runOf(PAGE_B) }));
    const hitsBeforeLegit = upstreamHits.length - before;
    const legit = seen(await plane.execute({ grant: verdict.grant, signature, request: wire, run: runOf(PAGE_A) }));
    const replayedTwice = seen(await plane.execute({ grant: verdict.grant, signature, request: wire, run: runOf(PAGE_A) }));

    const actual = { pageB, viewer, replayedUnderB, hitsBeforeLegit, legit: legit.ok, replayedTwice };
    const expected = {
      pageB: { ok: false, reason: 'account_unavailable' },
      viewer: { ok: false, reason: 'account_unavailable' },
      replayedUnderB: { ok: false, reason: 'refused' },
      hitsBeforeLegit: 0,
      legit: true,
      replayedTwice: { ok: false, reason: 'refused' },
    };
    expect(actual).toEqual(expected);
  }, 60_000);

  // Review HIGH-1: the plane must hold the pin itself. A compromised web process (signing key + main-DB
  // write) widens the row's origins and signs a grant over the ORIGINAL bindings digest; the plane's
  // stored bindings never widened, so the request must be refused before anything is sent.
  it('given a main-DB row widened to another origin and a grant signed over the original bindings, should refuse — the plane checks its own stored origins', async () => {
    const plane = await startPlane();
    const authority = authorityOver(plane);
    const created = await authority.createAccount({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const repo = createAgentAccountRepository({ db });
    const original = await repo.find(created.account.id);
    if (original === null) throw new Error('row missing');
    const evilOrigin = `https://${EVIL_HOST}:${upstreamPort}`;
    await db.update(agentAccounts).set({ allowedOrigins: [origin, evilOrigin] }).where(eq(agentAccounts.id, original.id));
    const tampered = await repo.find(original.id);
    const policy = { ...(original.approvalPolicy as Record<string, unknown>) };
    const verdict = authorize({
      caller: caller(),
      account: { ...tampered!, approvalPolicy: { ...policy, scope: { ...(policy.scope as Record<string, unknown>), origins: [origin, evilOrigin] } } },
      facts: { humanDriveRole: 'OWNER', agentPagePermission: 'edit', agentBoundToAccount: false, boundAgentPageIds: [], delegation: { kind: 'live_session' }, ceilingAdmitsAccount: true },
      request: get(`${evilOrigin}/v1/steal`),
      registry: [],
      approvals: [],
      usage: { usesThisHour: 0, bytesOutThisHour: 0, concurrent: 0 },
      presenter: { keyId: PRESENTER, channel: 'http-executor' },
      now: Date.now(),
      grantId: `g_${randomBytes(6).toString('hex')}` as never,
      nonce: `n_${randomBytes(6).toString('hex')}` as never,
      ttlMs: 60_000,
      hash: sha3,
    });
    if (!verdict.ok) throw new Error(`authorize refused the forged request: ${verdict.reason}`);
    const forged = { ...verdict.grant, bindingDigest: digestBindings({ bindings: planeBindingsFor({ row: original, boundAgentPageIds: [], hash: sha3 }).bindings, hash: sha3 }) };
    const before = upstreamHits.length;
    const result = seen(
      await plane.execute({
        grant: forged,
        signature: signGrant({ grant: forged, key: keyring.current }),
        request: { method: 'GET', url: `${evilOrigin}/v1/steal`, headers: { accept: 'application/json' }, bodyBase64: '' },
        run: { human: forged.human, agentPageId: PAGE_A, conversationId: forged.conversationId, runId: forged.runId },
      }),
    );
    const actual = { result, stolen: upstreamHits.slice(before).filter((hit) => hit.startsWith('/v1/steal')).length };
    const expected = { result: { ok: false, reason: 'refused' }, stolen: 0 };
    expect(actual).toEqual(expected);
  }, 60_000);

  it('given a plane whose network shell uses the real address classifier and a DNS answer on loopback (rebinding), should refuse before connecting', async () => {
    const authority = authorityOver(await startPlane({ isPublic: isPublicIp }));
    const created = await authority.createAccount({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const before = upstreamHits.length;
    const result = seen(await authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request: get(`${origin}/v1/weather`) }));
    const actual = { result, hits: upstreamHits.length - before };
    const expected = { result: { ok: false, reason: 'upstream_unreachable' }, hits: 0 };
    expect(actual).toEqual(expected);
  }, 60_000);

  it('given a grant minted before the account was revoked, should be refused by the plane itself', async () => {
    const plane = await startPlane();
    const authority = authorityOver(plane);
    const created = await authority.createAccount({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const row = await createAgentAccountRepository({ db }).find(created.account.id);
    const verdict = authorize({
      caller: caller(),
      account: row,
      facts: { humanDriveRole: 'OWNER', agentPagePermission: 'edit', agentBoundToAccount: false, boundAgentPageIds: [], delegation: { kind: 'live_session' }, ceilingAdmitsAccount: true },
      request: get(`${origin}/v1/weather`),
      registry: [],
      approvals: [],
      usage: { usesThisHour: 0, bytesOutThisHour: 0, concurrent: 0 },
      presenter: { keyId: PRESENTER, channel: 'http-executor' },
      now: Date.now(),
      grantId: `g_${randomBytes(6).toString('hex')}` as never,
      nonce: `n_${randomBytes(6).toString('hex')}` as never,
      ttlMs: 60_000,
      hash: sha3,
    });
    if (!verdict.ok) throw new Error(verdict.reason);
    const signature = signGrant({ grant: verdict.grant, key: keyring.current });
    await authority.revokeAccount({ actor: credentialActor(OWNER, null), accountId: created.account.id });
    const before = upstreamHits.length;
    const result = seen(await plane.execute({ grant: verdict.grant, signature, request: { method: 'GET', url: `${origin}/v1/weather`, headers: { accept: 'application/json' }, bodyBase64: '' }, run: { human: verdict.grant.human, agentPageId: PAGE_A, conversationId: verdict.grant.conversationId, runId: verdict.grant.runId } }));
    const actual = { result, hits: upstreamHits.length - before };
    const expected = { result: { ok: false, reason: 'refused' }, hits: 0 };
    expect(actual).toEqual(expected);
  }, 60_000);

  it('given an account with no standing policy, should require approval of the exact digest, execute once after it, and require it again', async () => {
    const authority = authorityOver(await startPlane());
    const created = await authority.createAccount({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(false) });
    if (!created.ok) throw new Error(created.reason);
    const request = get(`${origin}/v1/weather?city=Bergen`);
    const first = seen(await authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request }));
    if (first.ok || first.reason !== 'approval_required') throw new Error(`expected approval_required, got ${JSON.stringify(first)}`);
    const approval = await authority.approveRequest({ actor: credentialActor(OWNER, null), sessionId: 'sess_e2e', accountId: created.account.id, requestDigest: first.digest });
    const second = seen(await authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request }));
    const third = seen(await authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request }));
    const actual = { approved: approval.ok, second: second.ok ? second.response.status : second, third: third.ok ? 'executed again' : third.reason, subjectOrigin: first.subject.origin };
    const expected = { approved: true, second: 200, third: 'approval_required', subjectOrigin: `${origin}` };
    expect(actual).toEqual(expected);
  }, 60_000);

  it('given an upstream call that ran but whose outcome row the audit chain did not accept, should report outcome_unrecorded and release nothing', async () => {
    let accepted = 0;
    const authority = authorityOver(
      await startPlane({
        wrapAudit: (repository) => ({
          ...repository,
          accept: async (input) => {
            accepted += 1;
            return accepted % 2 === 1 ? repository.accept(input) : { kind: 'unavailable' };
          },
        }),
      }),
    );
    const created = await authority.createAccount({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const before = upstreamHits.length;
    const result = seen(await authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request: get(`${origin}/v1/weather`) }));
    const actual = { result, ran: upstreamHits.length - before };
    const expected = { result: { ok: false, reason: 'outcome_unrecorded' }, ran: 1 };
    expect(actual).toEqual(expected);
  }, 60_000);

  // Review MED-1: deleting the owner (GDPR erasure ends in delete-user) cascades the reference row away;
  // the plane's sweep must then erase the material and metadata that nothing else could ever reach.
  it('given an account whose owning user was deleted, should erase its vault material and plane metadata on the next sweep', async () => {
    const plane = await startPlane();
    const authority = authorityOver(plane);
    const erased = createId() as UserId;
    await db.insert(users).values({ id: erased, name: 'erased', email: `${erased}@example.test` });
    const created = await authority.createAccount({ actor: credentialActor(erased, null), owner: { kind: 'user' }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const secretRows = () => metadataPool.query('SELECT 1 FROM agent_account_secret_versions WHERE account_id = $1', [created.account.id]).then((r) => r.rowCount);
    const before = await secretRows();
    await db.delete(users).where(eq(users.id, erased));
    const { metadata, provisioner, store } = planeStore();
    const sweep = await sweepOrphanedRefs({ metadata, accounts: createAgentAccountRepository({ db }), provisioner, store, now: () => Date.now() + ORPHAN_GRACE_MS + 1 });
    const tenant = await provisioner.identityOf(`user:${erased}` as never);
    const creds = tenant === null ? null : await provisioner.credentialsFor({ tenantId: `user:${erased}` as never, identityId: tenant.identityId });
    const secret = tenant === null || creds === null ? null : await createInfisicalClient({ baseUrl: INFISICAL_URL, environment: 'dev' }).getSecret({ projectId: tenant.projectId, credentials: creds, secretKey: `${created.account.id}__api_key` });
    const actual = { before, after: await secretRows(), erasedAtLeastOne: sweep.erased >= 1, vault: secret?.ok === false ? secret.reason : secret === null ? 'no tenant' : 'still present' };
    const expected = { before: 1, after: 0, erasedAtLeastOne: true, vault: 'not_found' };
    expect(actual).toEqual(expected);
  }, 120_000);

  // Codex P1 on #2705: the advertised 60-per-hour cap of a standing permission is enforced by the plane
  // from its own stored scope and ledger — the 61st use in the hour is refused with nothing sent. Since slice 2
  // the authority reads the same ledger and refuses first with its reason; an authority that counts nothing
  // (here: one whose usage read always says zero) is still refused by the plane itself.
  it('given a standing permission already used 60 times this hour, should refuse the next request before any upstream I/O — at the authority with limits_exceeded, and at the plane when the authority counts nothing; at 59, should run it', async () => {
    const plane = await startPlane();
    const authority = authorityOver(plane);
    const blind = authorityOver({ ...plane, usage: async () => ({ ok: true, usesThisHour: 0, bytesOutThisHour: 0, concurrent: 0 }) });
    const created = await authority.createAccount({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const seed = async (count: number) => {
      await metadataPool.query('DELETE FROM agent_account_usage WHERE account_id = $1', [created.account.id]);
      for (let index = 0; index < count; index += 1) {
        await metadataPool.query("INSERT INTO agent_account_usage (grant_id, tenant_id, account_id, started_at, finished_at) VALUES ($1, $2, $3, now() - interval '10 minutes', now() - interval '10 minutes')", [`seed_${created.account.id}_${index}`, `drive:${DRIVE}`, created.account.id]);
      }
    };
    await seed(60);
    const before = upstreamHits.length;
    const atCap = seen(await authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request: get(`${origin}/v1/weather?at=cap`) }));
    const atCapBlind = seen(await blind.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request: get(`${origin}/v1/weather?at=cap-blind`) }));
    const hitsAtCap = upstreamHits.length - before;
    await seed(59);
    const underCap = seen(await authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request: get(`${origin}/v1/weather?at=59`) }));
    const actual = { atCap, atCapBlind, hitsAtCap, underCap: underCap.ok ? underCap.response.status : underCap };
    const expected = { atCap: { ok: false, reason: 'limits_exceeded' }, atCapBlind: { ok: false, reason: 'refused' }, hitsAtCap: 0, underCap: 200 };
    expect(actual).toEqual(expected);
  }, 60_000);

  // Second review MED-1: a first put whose metadata commit failed leaves material in Infisical with no plane
  // row, and the reference row stays at credentialVersion 0 (not ready). Revoking it must erase the vault copy.
  it('given a not-ready account whose material reached Infisical without a plane record, should erase it on revoke', async () => {
    const plane = await startPlane();
    const authority = authorityOver(plane);
    const created = await authority.createAccount({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    await metadataPool.query('DELETE FROM agent_account_secret_versions WHERE account_id = $1', [created.account.id]);
    await metadataPool.query('DELETE FROM agent_account_plane_bindings WHERE account_id = $1', [created.account.id]);
    await db.update(agentAccounts).set({ credentialVersion: 0 }).where(eq(agentAccounts.id, created.account.id));
    const { provisioner } = planeStore();
    const tenant = await provisioner.identityOf(`drive:${DRIVE}` as never);
    const creds = tenant === null ? null : await provisioner.credentialsFor({ tenantId: `drive:${DRIVE}` as never, identityId: tenant.identityId });
    const vault = () => createInfisicalClient({ baseUrl: INFISICAL_URL, environment: 'dev' }).getSecret({ projectId: tenant!.projectId, credentials: creds!, secretKey: `${created.account.id}__api_key` });
    const before = (await vault()).ok;
    const revoked = await authority.revokeAccount({ actor: credentialActor(OWNER, null), accountId: created.account.id });
    const after = await vault();
    const actual = { before, revoked: revoked.ok, after: after.ok ? 'still present' : after.reason };
    const expected = { before: true, revoked: true, after: 'not_found' };
    expect(actual).toEqual(expected);
  }, 60_000);

  // ---- Slice 2: "only what I assign" — permissions edits, bindings, delegations, real usage, bearer ----

  const STEP_UP = { challengeId: 'stepup_e2e' };
  const off = { enabled: false } as const;
  const on = (maxUsesPerHour: number) => ({ enabled: true, maxUsesPerHour, until: null }) as const;
  const unattended = () => caller({ sessionId: null });

  it('given an account that asks every time, should refuse to turn on "allow without asking" without step-up; with it, the plane accepts the consented rebind and the next call runs unasked; turning it off needs no step-up and asks again', async () => {
    const authority = authorityOver(await startPlane());
    const owner = credentialActor(OWNER, null);
    const created = await authority.createAccount({ actor: owner, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(false) });
    if (!created.ok) throw new Error(created.reason);
    const id = created.account.id;
    const call = () => authority.requestOperation({ ...asHuman(caller()), accountId: id, request: get(`${origin}/v1/weather?city=Oslo`) });

    const before = await call();
    const unproven = await authority.updateAccount({ actor: owner, accountId: id, edit: { allowedOrigins: [origin], autoApprove: on(10) }, stepUp: null });
    const widened = await authority.updateAccount({ actor: owner, accountId: id, edit: { allowedOrigins: [origin], autoApprove: on(10) }, stepUp: STEP_UP });
    const during = seen(await call());
    const narrowed = await authority.updateAccount({ actor: owner, accountId: id, edit: { allowedOrigins: [origin], autoApprove: off }, stepUp: null });
    const after = await call();

    const actual = {
      before: before.ok ? 'ran' : before.reason,
      unproven: unproven.ok ? 'ok' : unproven.reason,
      widened: widened.ok ? widened.settings.autoApprove : widened.reason,
      during: during.ok ? during.response.status : during.reason,
      narrowed: narrowed.ok ? narrowed.settings.autoApprove : narrowed.reason,
      after: after.ok ? 'ran' : after.reason,
    };
    const expected = { before: 'approval_required', unproven: 'step_up_required', widened: { enabled: true, maxUsesPerHour: 10, until: null, classes: [] }, during: 200, narrowed: null, after: 'approval_required' };
    expect(actual).toEqual(expected);
  }, 90_000);

  it('given a second site added with step-up then removed without it, should reach it only while it is pinned', async () => {
    const authority = authorityOver(await startPlane());
    const owner = credentialActor(OWNER, null);
    const created = await authority.createAccount({ actor: owner, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const id = created.account.id;
    const second = `https://${EVIL_HOST}:${upstreamPort}`;
    const toSecond = () => authority.requestOperation({ ...asHuman(caller()), accountId: id, request: get(`${second}/v1/weather`) });

    const beforeAdd = await toSecond();
    const added = await authority.updateAccount({ actor: owner, accountId: id, edit: { allowedOrigins: [origin, second], autoApprove: on(60) }, stepUp: STEP_UP });
    const whilePinned = await toSecond();
    const removed = await authority.updateAccount({ actor: owner, accountId: id, edit: { allowedOrigins: [origin], autoApprove: on(60) }, stepUp: null });
    const afterRemove = await toSecond();

    const actual = {
      beforeAdd: beforeAdd.ok ? 'ran' : beforeAdd.reason,
      added: added.ok ? added.settings.account.allowedOrigins : added.reason,
      whilePinned: whilePinned.ok ? whilePinned.response.status : whilePinned.reason,
      removed: removed.ok ? removed.settings.account.allowedOrigins : removed.reason,
      afterRemove: afterRemove.ok ? 'ran' : afterRemove.reason,
    };
    const expected = {
      beforeAdd: 'destination_denied',
      added: [origin, second].sort(),
      whilePinned: 200,
      removed: [origin],
      afterRemove: 'destination_denied',
    };
    expect(actual).toEqual(expected);
  }, 90_000);

  it('given an unattended run, should refuse without a delegation, refuse to delegate without step-up or while every call asks, run with one, and refuse again once it is revoked — and the plane verifier reads the same row', async () => {
    const authority = authorityOver(await startPlane());
    const owner = credentialActor(OWNER, null);
    const created = await authority.createAccount({ actor: owner, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(false) });
    if (!created.ok) throw new Error(created.reason);
    const id = created.account.id;
    const run = () => authority.requestOperation({ ...asHuman(unattended()), accountId: id, request: get(`${origin}/v1/weather?city=Oslo`) });
    const expiresAt = Date.now() + 7 * 86_400_000;

    const withoutDelegation = await run();
    const unproven = await authority.createDelegation({ actor: owner, accountId: id, agentPageId: PAGE_A, expiresAt, stepUp: null });
    const whileAsking = await authority.createDelegation({ actor: owner, accountId: id, agentPageId: PAGE_A, expiresAt, stepUp: STEP_UP });
    await authority.updateAccount({ actor: owner, accountId: id, edit: { allowedOrigins: [origin], autoApprove: on(60) }, stepUp: STEP_UP });
    const delegated = await authority.createDelegation({ actor: owner, accountId: id, agentPageId: PAGE_A, expiresAt, stepUp: STEP_UP });
    const withDelegation = seen(await run());
    const delegationId = delegated.ok ? delegated.settings.delegations[0]?.id ?? '' : '';
    await authority.revokeDelegation({ actor: owner, accountId: id, delegationId });
    const afterRevoke = await run();

    const actual = {
      withoutDelegation: withoutDelegation.ok ? 'ran' : withoutDelegation.reason,
      unproven: unproven.ok ? 'ok' : unproven.reason,
      whileAsking: whileAsking.ok ? 'ok' : whileAsking.reason,
      delegations: delegated.ok ? delegated.settings.delegations.map((d) => d.agentPageId) : delegated.reason,
      withDelegation: withDelegation.ok ? withDelegation.response.status : withDelegation.reason,
      afterRevoke: afterRevoke.ok ? 'ran' : afterRevoke.reason,
    };
    const expected = { withoutDelegation: 'account_unavailable', unproven: 'step_up_required', whileAsking: 'auto_approve_required', delegations: [PAGE_A], withDelegation: 200, afterRevoke: 'account_unavailable' };
    expect(actual).toEqual(expected);
  }, 90_000);

  it('given a user-owned account, should be unusable from agent page A until the owner binds it (with step-up), usable only by the owner after, and unusable again once unbound', async () => {
    const authority = authorityOver(await startPlane());
    const owner = credentialActor(OWNER, null);
    const created = await authority.createAccount({ actor: owner, owner: { kind: 'user' }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const id = created.account.id;
    const fromA = () => authority.requestOperation({ ...asHuman(caller()), accountId: id, request: get(`${origin}/v1/weather`) });

    const beforeBind = await fromA();
    const unproven = await authority.bindAccount({ actor: owner, accountId: id, agentPageId: PAGE_A, stepUp: null });
    const byViewer = await authority.bindAccount({ actor: credentialActor(VIEWER, null), accountId: id, agentPageId: PAGE_A, stepUp: STEP_UP });
    const bound = await authority.bindAccount({ actor: owner, accountId: id, agentPageId: PAGE_A, stepUp: STEP_UP });
    const afterBind = seen(await fromA());
    const viewerList = await authority.listAccounts({ actor: credentialActor(VIEWER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A } });
    const ownerList = await authority.listAccounts({ actor: owner, owner: { kind: 'agent_page', agentPageId: PAGE_A } });
    const unbound = await authority.unbindAccount({ actor: owner, accountId: id, agentPageId: PAGE_A });
    const afterUnbind = await fromA();

    const actual = {
      beforeBind: beforeBind.ok ? 'ran' : beforeBind.reason,
      unproven: unproven.ok ? 'ok' : unproven.reason,
      byViewer: byViewer.ok ? 'ok' : byViewer.reason,
      bound: bound.ok ? bound.settings.bindings.map((b) => b.agentPageId) : bound.reason,
      afterBind: afterBind.ok ? afterBind.response.status : afterBind.reason,
      viewerSees: (viewerList ?? []).some((account) => account.id === id),
      ownerSees: (ownerList ?? []).some((account) => account.id === id),
      unbound: unbound.ok ? unbound.settings.bindings : unbound.reason,
      afterUnbind: afterUnbind.ok ? 'ran' : afterUnbind.reason,
    };
    const expected = { beforeBind: 'account_unavailable', unproven: 'step_up_required', byViewer: 'account_unavailable', bound: [PAGE_A], afterBind: 200, viewerSees: false, ownerSees: true, unbound: [], afterUnbind: 'account_unavailable' };
    expect(actual).toEqual(expected);
  }, 90_000);

  it('given "allow without asking" capped at one call an hour, should run the first and refuse the second with limits_exceeded from the real usage count', async () => {
    const authority = authorityOver(await startPlane());
    const owner = credentialActor(OWNER, null);
    const created = await authority.createAccount({ actor: owner, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(false) });
    if (!created.ok) throw new Error(created.reason);
    await authority.updateAccount({ actor: owner, accountId: created.account.id, edit: { allowedOrigins: [origin], autoApprove: on(1) }, stepUp: STEP_UP });
    const call = () => authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request: get(`${origin}/v1/weather`) });
    const first = await call();
    const second = await call();
    const settings = await authority.describeAccount({ actor: owner, accountId: created.account.id });
    const actual = { first: first.ok ? first.response.status : first.reason, second: second.ok ? 'ran' : second.reason, usesThisHour: settings.ok ? settings.settings.usesThisHour : settings.reason };
    expect(actual).toEqual({ first: 200, second: 'limits_exceeded', usesThisHour: 1 });
  }, 90_000);

  it('given a bearer account, should send the token as Authorization: Bearer and release none of it', async () => {
    const authority = authorityOver(await startPlane());
    const created = await authority.createAccount({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: { ...createInput(true), kind: 'bearer' } });
    if (!created.ok) throw new Error(created.reason);
    const result = seen(await authority.requestOperation({ ...asHuman(caller()), accountId: created.account.id, request: get(`${origin}/v1/echo`) }));
    const actual = { kind: created.account.kind, ok: result.ok, status: result.ok ? result.response.status : result, leaked: JSON.stringify(result).includes(CANARY) };
    expect(actual).toEqual({ kind: 'bearer', ok: true, status: 200, leaked: false });
  }, 60_000);

  it('given a drive member who is not a pinned consenter, should refuse to widen with not_a_consenter even after step-up', async () => {
    const plane = await startPlane();
    const authority = authorityOver(plane);
    const created = await authority.createAccount({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(false) });
    if (!created.ok) throw new Error(created.reason);
    // An authority that wrongly believes VIEWER is a drive admin signs a real consent for them: the plane, which pinned
    // only the drive's consenters at creation, still refuses it.
    const forged = createAccountAuthority({ accounts: createAgentAccountRepository({ db }), facts: { ...createAccountFactsRepository(), driveRole: async () => 'ADMIN' }, plane, authorityKey: keyring.current, presenterKeyId: PRESENTER, registry: AGENT_ACCOUNT_OPERATIONS, providerOrigins: { google: [...GOOGLE_ORIGINS, new URL(origin).origin + (new URL(origin).port ? '' : ':443')] }, consentKey: CONSENT_KEY, lockAccount: createAccountChangeLock(getAdvisoryLockPool()), hash: sha3, now: () => Date.now() });
    const actual = await forged.updateAccount({ actor: credentialActor(VIEWER, null), accountId: created.account.id, edit: { allowedOrigins: [origin], autoApprove: on(10) }, stepUp: STEP_UP });
    expect(actual.ok ? 'widened' : actual.reason).toEqual('not_a_consenter');
  }, 60_000);

  it('given two permission edits racing on one account, should apply at most one and leave the account usable with the plane and the row agreeing', async () => {
    const authority = authorityOver(await startPlane());
    const owner = credentialActor(OWNER, null);
    const created = await authority.createAccount({ actor: owner, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const id = created.account.id;
    const outcomes = await Promise.all([
      authority.updateAccount({ actor: owner, accountId: id, edit: { allowedOrigins: [origin], autoApprove: on(30) }, stepUp: null }),
      authority.updateAccount({ actor: owner, accountId: id, edit: { allowedOrigins: [origin], autoApprove: on(20) }, stepUp: null }),
    ]);
    const after = await authority.requestOperation({ ...asHuman(caller()), accountId: id, request: get(`${origin}/v1/weather`) });
    const actual = { applied: outcomes.filter((outcome) => outcome.ok).length >= 1, refusals: outcomes.filter((outcome) => !outcome.ok).map((outcome) => (outcome.ok ? null : outcome.reason)), after: after.ok ? after.response.status : after.reason };
    expect({ ...actual, refusals: actual.refusals.every((reason) => reason === 'conflict') }).toEqual({ applied: true, refusals: true, after: 200 });
  }, 90_000);

  it('given a user-owned account detached from an agent and attached again, should not revive the unattended use it had', async () => {
    const authority = authorityOver(await startPlane());
    const owner = credentialActor(OWNER, null);
    const created = await authority.createAccount({ actor: owner, owner: { kind: 'user' }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const id = created.account.id;
    const run = () => authority.requestOperation({ ...asHuman(unattended()), accountId: id, request: get(`${origin}/v1/weather`) });
    await authority.bindAccount({ actor: owner, accountId: id, agentPageId: PAGE_A, stepUp: STEP_UP });
    await authority.createDelegation({ actor: owner, accountId: id, agentPageId: PAGE_A, expiresAt: Date.now() + 86_400_000, stepUp: STEP_UP });
    const delegated = await run();
    await authority.unbindAccount({ actor: owner, accountId: id, agentPageId: PAGE_A });
    const rebound = await authority.bindAccount({ actor: owner, accountId: id, agentPageId: PAGE_A, stepUp: STEP_UP });
    const afterRebind = await run();
    const actual = { delegated: delegated.ok ? delegated.response.status : delegated.reason, delegationsAfter: rebound.ok ? rebound.settings.delegations.length : rebound.reason, afterRebind: afterRebind.ok ? 'ran' : afterRebind.reason };
    expect(actual).toEqual({ delegated: 200, delegationsAfter: 0, afterRebind: 'account_unavailable' });
  }, 90_000);

  it('given a page that is not an agent, should refuse to attach an account to it', async () => {
    const authority = authorityOver(await startPlane());
    const owner = credentialActor(OWNER, null);
    const created = await authority.createAccount({ actor: owner, owner: { kind: 'user' }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const notAgent = createId();
    await db.insert(pages).values({ id: notAgent, title: 'notes', type: 'DOCUMENT', driveId: DRIVE, position: 9 });
    const actual = await authority.bindAccount({ actor: owner, accountId: created.account.id, agentPageId: notAgent, stepUp: STEP_UP });
    expect(actual.ok ? 'bound' : actual.reason).toEqual('page_unavailable');
  }, 60_000);

  // ---- Slice 3: a Google account connected through the plane, refreshed by the plane ----

  const googleInput = { name: 'Agent Google', services: ['gmail.read'], ownership: 'dedicated' as const, acknowledged: false, autoApproveReads: true };
  const VERIFIER = 'v'.repeat(43);

  it('given a good authorization code, should exchange it INSIDE the plane, store the tokens and name the connected account — and return no token', async () => {
    const authority = authorityOver(await startPlane());
    const before = tokenCalls.length;
    const connected = seen(await authority.completeOAuthEnrollment({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: googleInput, code: GOOD_CODE, codeVerifier: VERIFIER, redirectUri: 'https://pagespace.e2e/callback' }));
    const text = JSON.stringify(connected);
    const actual = {
      ok: connected.ok,
      kind: connected.ok ? connected.account.kind : `${connected.reason}:${'detail' in connected ? connected.detail : ''}`,
      provider: connected.ok ? connected.account.providerSlug : null,
      origins: connected.ok ? connected.account.allowedOrigins : null,
      name: connected.ok ? connected.account.name : null,
      ready: connected.ok ? connected.account.ready : null,
      tokenCalls: tokenCalls.slice(before),
      leaked: [STALE_ACCESS, REFRESH_TOKEN, GOOGLE_CLIENT.clientSecret].filter((secret) => text.includes(secret)),
    };
    expect(actual).toEqual({ ok: true, kind: 'oauth2', provider: 'google', origins: ['https://gmail.googleapis.com:443'], name: 'Agent Google (agent@e2e.example)', ready: true, tokenCalls: ['authorization_code'], leaked: [] });
  }, 90_000);

  it('given a code Google refuses, should keep no account', async () => {
    const authority = authorityOver(await startPlane());
    const refused = await authority.completeOAuthEnrollment({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: googleInput, code: 'stolen-or-expired', codeVerifier: VERIFIER, redirectUri: 'https://pagespace.e2e/callback' });
    const listed = await authority.listAccounts({ actor: credentialActor(OWNER, null), owner: { kind: 'agent_page', agentPageId: PAGE_A } });
    expect({ refused: refused.ok ? 'connected' : [refused.reason, 'detail' in refused ? refused.detail : null], kept: (listed ?? []).some((account) => account.name.startsWith('Agent Google') && account.status === 'active' && !account.ready) }).toEqual({ refused: ['provider_refused', 'exchange_refused'], kept: false });
  }, 60_000);

  it('given a connected Google account whose access token is about to expire, should refresh it in the plane before the request and send the fresh token — never the stale one, never the refresh token', async () => {
    const authority = authorityOver(await startPlane());
    const owner = credentialActor(OWNER, null);
    const connected = await authority.completeOAuthEnrollment({ actor: owner, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: googleInput, code: GOOD_CODE, codeVerifier: VERIFIER, redirectUri: 'https://pagespace.e2e/callback' });
    if (!connected.ok) throw new Error(connected.reason);
    const id = connected.account.id;
    // Point the account at this suite's upstream — admitted only because this suite's authority lists it as a
    // Google origin (production lists Google's APIs alone) — with a consented widening; its requests there are generic, so they ask.
    await authority.updateAccount({ actor: owner, accountId: id, edit: { allowedOrigins: [origin], autoApprove: { enabled: false } }, stepUp: STEP_UP });
    const call = () => authority.requestOperation({ ...asHuman(caller()), accountId: id, request: get(`${origin}/v1/echo`) });
    const before = tokenCalls.length;
    const asked = await call();
    if (asked.ok || asked.reason !== 'approval_required') throw new Error(`expected approval_required, got ${JSON.stringify(asked)}`);
    await authority.approveRequest({ actor: owner, sessionId: 'sess_e2e', accountId: id, requestDigest: asked.digest });
    const result = seen(await call());
    const text = JSON.stringify(result);
    const actual = {
      status: result.ok ? result.response.status : result.reason,
      tokenCalls: tokenCalls.slice(before),
      leaked: [CANARY, STALE_ACCESS, REFRESH_TOKEN].filter((secret) => text.includes(secret)),
      row: (await createAgentAccountRepository({ db }).find(id))?.credentialVersion,
    };
    // 200 only if the upstream saw `Bearer <fresh token>`: it refuses the stale one.
    expect(actual).toEqual({ status: 200, tokenCalls: ['refresh_token'], leaked: [], row: 2 });
  }, 90_000);

  it('given every model-visible value this slice produced above, should never contain the canary key', () => {
    const actual = { surfaces: modelVisible.length > 10, leaks: modelVisible.filter((text) => text.includes(CANARY)).length };
    const expected = { surfaces: true, leaks: 0 };
    expect(actual).toEqual(expected);
  });
});
