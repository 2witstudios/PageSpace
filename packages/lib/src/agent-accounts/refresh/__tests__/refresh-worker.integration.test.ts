/**
 * L3·G3 — the refresh worker against the REAL things it adapts (Control
 * Board §7.3): a local Infisical OSS instance and the plane's own metadata
 * Postgres (`store/infisical-dev/`), and a real TLS token endpoint on
 * loopback reached through the pinned HTTPS client. Synthetic tokens only.
 *
 * Task requirements pinned here:
 * 1. Two concurrent refreshes for one connection perform exactly ONE upstream
 *    refresh and both callers get the new token — in one process (shared
 *    in-flight refresh) and across two worker instances standing in for two
 *    replicas (the advisory try-lock + re-resolve under it).
 * 2. A rotated refresh token plus a crash between the Infisical write and the
 *    plane's metadata commit recovers without losing the family: the store's
 *    pending-write reconcile commits the rotation forward, and the rotated
 *    refresh token (not the spent one) is what the next refresh presents.
 * 3. A provider revocation (401 invalid_grant) marks the account needs_reauth
 *    and is never retried: a second call makes no upstream request.
 *
 * Skips itself visibly when Infisical is unreachable (the same probe as
 * `store-adapter-infisical.integration.test.ts`); CI runs it in the
 * Infisical step, which fails a skipped or partial run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, verify as nodeVerify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { get } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createId } from '@paralleldrive/cuid2';
import type { AccountId, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type { AgentAccountGrant, ApprovalId, ConversationId, Ed25519Verify, GrantId, GrantIssuer, HashBytes, Nonce, PresenterKeyId, RequestDigest, RunId, SessionId, UserId } from '../../grant';
import type { CanonicalOrigin } from '../../canonical-request';
import type { PlaneBindings, PlaneScope, SecretMaterialByKind, StoreAdapter, VerifiedGrant, WriteDigestKey } from '../../store/store-adapter';
import { digestBindings } from '../../store/digest-bindings';
import { digestPlaneScope } from '../../store/digest-plane-scope';
import { createInfisicalClient } from '../../store/infisical-client';
import { createPlaneMetadataRepository, type PlaneMetadataRepository } from '../../store/plane-metadata-repository';
import { createInfisicalStoreAdapter } from '../../store/store-adapter-infisical';
import { createConsentLedgerRepository } from '../../store/consent-ledger-repository';
import { createInfisicalTenantProvisioner, type TenantProvisioner } from '../../store/infisical-tenant-provisioner-client';
import { createPinnedHttpsClient } from '../../executor/pinned-https-client';
import { createRefreshAttemptRepository } from '../refresh-attempt-repository';
import { createRefreshWorker, type OAuth2Ref, type RefreshWorkerDeps } from '../refresh-worker';
import type { OAuthEndpointRegistry } from '../decide-refresh-endpoint';

const INFISICAL_URL = process.env.INFISICAL_DEV_URL ?? 'http://localhost:8080';
const ADMIN_TOKEN = process.env.INFISICAL_DEV_ADMIN_TOKEN;
const METADATA_URL = process.env.PLANE_METADATA_DEV_URL ?? 'postgres://plane_metadata:plane_metadata@127.0.0.1:55433/plane_metadata';
const HOST = 'token.refresh-itest.example';
const ISSUER = `https://${HOST}`;
const CLIENT = { clientId: 'itest-client', clientSecret: randomBytes(16).toString('hex') };

const sha3: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const verifyEd25519: Ed25519Verify = (message, signature, publicKey) => nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);

const reachable = ADMIN_TOKEN
  ? await new Promise<boolean>((resolve) => {
      const req = get(`${INFISICAL_URL}/api/status`, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    })
  : false;

/** The token endpoint's state: which refresh token is live, what it answers, and every request it saw. */
type ProviderMode = 'rotate' | 'revoked';
const provider = {
  mode: 'rotate' as ProviderMode,
  delayMs: 0,
  generation: 0,
  liveRefreshToken: '',
  hits: [] as { readonly refreshToken: string; readonly authorization: string | undefined }[],
};

let certDir: string;
let ca: string;
let tokenServer: HttpsServer;
let tokenEndpoint: string;
let metadataPool: Pool;
let orgId = '';

function openssl(args: readonly string[]) {
  execFileSync('openssl', args, { cwd: certDir, stdio: 'ignore' });
}

function startTokenServer(): Promise<void> {
  writeFileSync(path.join(certDir, 'leaf.ext'), `subjectAltName=DNS:${HOST}\n`);
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-subj', '/CN=g3-refresh-ca', '-days', '1', '-out', 'ca.pem']);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-subj', `/CN=${HOST}`, '-out', 'leaf.csr']);
  openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'leaf.ext', '-out', 'leaf.pem']);
  ca = execFileSync('openssl', ['x509', '-in', 'ca.pem'], { cwd: certDir }).toString('utf8');
  tokenServer = createHttpsServer({ key: readFileSync(path.join(certDir, 'leaf.key')), cert: readFileSync(path.join(certDir, 'leaf.pem')) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const presented = form.get('refresh_token') ?? '';
      provider.hits.push({ refreshToken: presented, authorization: req.headers.authorization });
      const answer = () => {
        if (provider.mode === 'revoked' || form.get('grant_type') !== 'refresh_token' || presented !== provider.liveRefreshToken) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
        // A rotating provider: the presented refresh token is spent the moment it is exchanged.
        provider.generation += 1;
        provider.liveRefreshToken = `synthetic-refresh-${provider.generation}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: `synthetic-access-${provider.generation}`, token_type: 'Bearer', expires_in: 3600, refresh_token: provider.liveRefreshToken }));
      };
      if (provider.delayMs > 0) setTimeout(answer, provider.delayMs);
      else answer();
    });
  });
  return new Promise((resolve) =>
    tokenServer.listen(0, '127.0.0.1', () => {
      tokenEndpoint = `https://${HOST}:${(tokenServer.address() as AddressInfo).port}/token`;
      resolve();
    }),
  );
}

const registry = (): OAuthEndpointRegistry => ({ itest: { issuer: ISSUER, tokenEndpoint, revocationEndpoint: null, clientAuth: 'client_secret_basic' } });

function planeStore({ wrapMetadata = (m: PlaneMetadataRepository) => m }: { readonly wrapMetadata?: (m: PlaneMetadataRepository) => PlaneMetadataRepository } = {}) {
  const realMetadata = createPlaneMetadataRepository({ pool: metadataPool as never });
  const metadata = { ...wrapMetadata(realMetadata), advisoryLockPool: realMetadata.advisoryLockPool };
  const provisioner = createInfisicalTenantProvisioner({ baseUrl: INFISICAL_URL, organizationId: orgId, auth: { kind: 'token', token: ADMIN_TOKEN ?? '' }, pool: metadataPool as never, advisoryLockPool: metadata.advisoryLockPool });
  const store = createInfisicalStoreAdapter({
    infisical: createInfisicalClient({ baseUrl: INFISICAL_URL, environment: 'dev' }),
    metadata,
    advisoryLockPool: metadata.advisoryLockPool,
    resolveProject: (tenantId) => provisioner.projectOf(tenantId),
    resolveCredentials: (input) => provisioner.credentialsFor(input),
    hash: sha3,
    writeDigestKey: WRITE_DIGEST_KEY,
    hmac: (key, bytes) => createHmac('sha3-256', key).update(bytes).digest('hex'),
    now: () => Date.now(),
    consentPublicKey: new Uint8Array(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' })),
    verify: verifyEd25519,
    consentLedger: createConsentLedgerRepository({ pool: metadataPool }),
  });
  return { metadata, provisioner, store };
}
/** One key for every store instance in the run, as one plane process would hold. */
const WRITE_DIGEST_KEY = new Uint8Array(randomBytes(32)) as WriteDigestKey;

type Seeded = { readonly ref: OAuth2Ref; readonly bindings: PlaneBindings; readonly version: CredentialVersion };

/** A user-owned oauth2 account in its own tenant, put through the ingress path with an EXPIRED access token. */
async function seedAccount(store: StoreAdapter, provisioner: TenantProvisioner): Promise<Seeded> {
  const userId = createId();
  const tenantId = `user:${userId}` as TenantId;
  const ref: OAuth2Ref = { tenantId, accountId: createId() as AccountId, kind: 'oauth2' };
  const scope: PlaneScope = {
    approvalPolicy: null,
    resourceRestrictions: {},
    boundAgentPageIds: [],
    allowedOrigins: ['https://api.refresh-itest.example' as CanonicalOrigin],
    auxiliaryOrigins: [],
    sessionHttpEnabled: false,
    providerSlug: 'itest',
  };
  const bindings: PlaneBindings = { tenantId, ownerRef: { kind: 'user', userId }, allowedOrigins: scope.allowedOrigins, policyVersion: 1 as PolicyVersion, policyDigest: digestPlaneScope({ scope, hash: sha3 }), kind: 'oauth2' };
  provider.generation = 0;
  provider.liveRefreshToken = 'synthetic-refresh-0';
  const material: SecretMaterialByKind['oauth2'] = {
    accessToken: 'synthetic-access-0',
    accessExpiresAt: Date.now() - 1_000,
    refreshToken: provider.liveRefreshToken,
    scopes: ['calendar.read'],
    issuer: ISSUER,
    tokenEndpoint,
  };
  const tenant = await provisioner.ensureTenant(tenantId);
  if (tenant === null) throw new Error('tenant provisioning failed');
  const put = await store.put({ ref, material: { kind: 'oauth2', material }, expectedVersion: null, bindings, scope, consenters: { kind: 'owner' }, identity: { tenantId, identityId: tenant.identityId, channel: 'ingress', blastRadius: 'tenant' } });
  if (!put.ok) throw new Error(`seed put failed: ${put.reason}`);
  return { ref, bindings, version: put.version };
}

/** The grant the refresh worker presents — built here as a VERIFIED grant (the authority's issuance of it is the open ruling). */
function refreshGrant(seeded: Seeded, version: CredentialVersion): VerifiedGrant<'refresh-worker'> {
  const now = Date.now();
  const grant: AgentAccountGrant = {
    grantId: createId() as GrantId,
    iss: 'pagespace-account-authority' as GrantIssuer,
    aud: 'refresh-worker',
    tenantId: seeded.ref.tenantId,
    human: { userId: 'itest-user' as UserId, sessionId: 'itest-session' as SessionId },
    delegationId: null,
    agentPageId: null,
    conversationId: 'itest-conv' as ConversationId,
    runId: 'itest-run' as RunId,
    sandbox: null,
    callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
    accountId: seeded.ref.accountId,
    accountKind: 'oauth2',
    credentialVersion: version,
    policyVersion: seeded.bindings.policyVersion,
    bindingDigest: digestBindings({ bindings: seeded.bindings, hash: sha3 }),
    operation: { class: 'read', name: 'oauth2.refresh' },
    requestDigest: 'itest-refresh' as RequestDigest,
    sessionHttp: false,
    approvalId: 'policy' as ApprovalId | 'policy',
    iat: now - 1_000,
    nbf: now - 1_000,
    exp: now + 60_000,
    nonce: createId() as Nonce,
    presenter: { keyId: 'itest-presenter' as PresenterKeyId, channel: 'refresh-worker' },
  };
  return grant as VerifiedGrant<'refresh-worker'>;
}

/** A recording stand-in for the MAIN-DB reference row writes (their own integration test is agent-account-repository's). */
function recordingAccounts() {
  const calls: { readonly op: 'advance' | 'needs_reauth'; readonly id: string; readonly from?: number; readonly to?: number }[] = [];
  return {
    calls,
    accounts: {
      advanceCredentialVersion: async ({ id, from, to }: { id: string; from: number; to: number }) => {
        calls.push({ op: 'advance', id, from, to });
        return true;
      },
      markNeedsReauth: async ({ id }: { id: string; at: number }) => {
        calls.push({ op: 'needs_reauth', id });
        return true;
      },
    },
  };
}

function workerOver({ store, provisioner }: { readonly store: StoreAdapter; readonly provisioner: TenantProvisioner }, seeded: Seeded, accounts: RefreshWorkerDeps['accounts']) {
  return createRefreshWorker({
    store,
    resolveRefreshable: ({ ref, version }) =>
      provisioner.identityOf(ref.tenantId).then((tenant) =>
        tenant === null
          ? { ok: false as const, reason: 'store_unavailable' as const }
          : store.resolve({ ref, version, grant: refreshGrant(seeded, version), identity: { tenantId: ref.tenantId, identityId: tenant.identityId, channel: 'refresh-worker', blastRadius: 'tenant' } }),
      ),
    currentVersion: (ref) => createPlaneMetadataRepository({ pool: metadataPool as never }).read(ref).then((facts) => facts?.currentVersion ?? null),
    identityFor: (ref) => provisioner.identityOf(ref.tenantId).then((tenant) => (tenant === null ? null : { tenantId: ref.tenantId, identityId: tenant.identityId, channel: 'refresh-worker' as const, blastRadius: 'tenant' as const })),
    attempts: createRefreshAttemptRepository({ pool: metadataPool }),
    advisoryLockPool: createPlaneMetadataRepository({ pool: metadataPool as never }).advisoryLockPool,
    network: createPinnedHttpsClient({ resolveHost: async () => [{ address: '127.0.0.1', family: 4 }], isPublic: () => true, ca, limits: { totalTimeoutMs: 10_000, maxResponseBytes: 64 * 1024, maxConcurrent: 8 } }),
    registry: registry(),
    clientFor: (slug) => (slug === 'itest' ? CLIENT : null),
    accounts,
    now: () => Date.now(),
    marginMs: 60_000,
  });
}

const request = (seeded: Seeded, version: CredentialVersion = seeded.version) => ({ ref: seeded.ref, version, providerSlug: 'itest', bindings: seeded.bindings });

describe.skipIf(!reachable)('refresh worker against real Infisical, plane metadata and a TLS token endpoint', () => {
  beforeAll(async () => {
    certDir = mkdtempSync(path.join(tmpdir(), 'g3-refresh-'));
    await startTokenServer();
    metadataPool = new Pool({ connectionString: METADATA_URL });
    await metadataPool.query('SELECT 1 FROM agent_account_refresh_attempts LIMIT 0');
    orgId = process.env.INFISICAL_DEV_ORG_ID ?? '';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (tokenServer ? tokenServer.close(() => resolve()) : resolve()));
    if (metadataPool) await metadataPool.end();
    if (certDir) rmSync(certDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    provider.mode = 'rotate';
    provider.delayMs = 0;
    provider.hits.length = 0;
  });

  it('given an expired access token, should refresh once, rotate the plane to the new material and mirror the version', async () => {
    const plane = planeStore();
    const seeded = await seedAccount(plane.store, plane.provisioner);
    const recorded = recordingAccounts();
    const outcome = await workerOver(plane, seeded, recorded.accounts).ensureFresh(request(seeded));

    const actual = {
      outcome: outcome.ok ? { accessToken: outcome.material.accessToken, version: outcome.version, refreshed: outcome.refreshed, leaksRefreshToken: 'refreshToken' in outcome.material } : outcome,
      hits: provider.hits.map((hit) => hit.refreshToken),
      basicAuth: provider.hits[0]?.authorization?.startsWith('Basic ') ?? false,
      mirrored: recorded.calls,
    };
    const expected = {
      outcome: { accessToken: 'synthetic-access-1', version: seeded.version + 1, refreshed: true, leaksRefreshToken: false },
      hits: ['synthetic-refresh-0'],
      basicAuth: true,
      mirrored: [{ op: 'advance', id: seeded.ref.accountId, from: seeded.version, to: seeded.version + 1 }],
    };
    expect(actual).toEqual(expected);
  });

  it('given two concurrent refreshes in one process, should make exactly one upstream refresh and give both callers the new token', async () => {
    const plane = planeStore();
    const seeded = await seedAccount(plane.store, plane.provisioner);
    provider.delayMs = 300;
    const worker = workerOver(plane, seeded, recordingAccounts().accounts);
    const [a, b] = await Promise.all([worker.ensureFresh(request(seeded)), worker.ensureFresh(request(seeded))]);

    const actual = { hits: provider.hits.length, a: a.ok ? a.material.accessToken : a.reason, b: b.ok ? b.material.accessToken : b.reason };
    const expected = { hits: 1, a: 'synthetic-access-1', b: 'synthetic-access-1' };
    expect(actual).toEqual(expected);
  });

  it('given two replicas refreshing one account at once, should make exactly one upstream refresh; the other replica refreshes nothing and gets the new token on re-issue', async () => {
    const seededPlane = planeStore();
    const seeded = await seedAccount(seededPlane.store, seededPlane.provisioner);
    provider.delayMs = 500;
    const replicaA = workerOver(planeStore(), seeded, recordingAccounts().accounts);
    const replicaB = workerOver(planeStore(), seeded, recordingAccounts().accounts);
    const [a, b] = await Promise.all([replicaA.ensureFresh(request(seeded)), replicaB.ensureFresh(request(seeded))]);
    provider.delayMs = 0;
    const winner = [a, b].find((outcome) => outcome.ok);
    // The loser re-issues with the version the winner rotated to — what the executor does on refresh_in_progress/version_conflict.
    const reissued = winner?.ok ? await replicaB.ensureFresh(request(seeded, winner.version)) : null;

    const actual = {
      hits: provider.hits.length,
      outcomes: [a, b].map((outcome) => (outcome.ok ? 'refreshed' : outcome.reason)).sort(),
      reissued: reissued?.ok ? { accessToken: reissued.material.accessToken, refreshed: reissued.refreshed } : reissued,
    };
    const expected = {
      hits: 1,
      outcomes: ['refresh_in_progress', 'refreshed'],
      reissued: { accessToken: 'synthetic-access-1', refreshed: false },
    };
    expect(actual).toEqual(expected);
  });

  it('given a crash between the rotated write and the plane metadata commit, should recover the rotated family: the next refresh presents the NEW refresh token', async () => {
    const plane = planeStore();
    const seeded = await seedAccount(plane.store, plane.provisioner);
    const crashing = planeStore({ wrapMetadata: (m) => ({ ...m, commit: async () => { throw new Error('synthetic crash between Infisical write and metadata commit'); } }) });
    const crashed = await workerOver(crashing, seeded, recordingAccounts().accounts).ensureFresh(request(seeded));

    // The next locked call on the ref reconciles the pending rotation forward (ADR 0005 §2.3, E1).
    const healthy = workerOver(plane, seeded, recordingAccounts().accounts);
    const afterCrash = await healthy.ensureFresh(request(seeded));
    const rotatedVersion = (seeded.version + 1) as CredentialVersion;
    const current = await healthy.ensureFresh(request(seeded, rotatedVersion));

    // Force the next refresh: the provider must receive the refresh token issued in the crashed exchange.
    const expireNow = await plane.provisioner.identityOf(seeded.ref.tenantId);
    const resolved = await plane.store.resolve({ ref: seeded.ref, version: rotatedVersion, grant: refreshGrant(seeded, rotatedVersion), identity: { tenantId: seeded.ref.tenantId, identityId: expireNow?.identityId ?? '', channel: 'refresh-worker', blastRadius: 'tenant' } });

    const actual = {
      crashed: crashed.ok ? 'ok' : crashed.reason,
      afterCrash: afterCrash.ok ? 'ok' : afterCrash.reason,
      current: current.ok ? { accessToken: current.material.accessToken, version: current.version } : current.reason,
      storedRefreshToken: resolved.ok ? resolved.material.refreshToken : resolved.reason,
      liveAtProvider: provider.liveRefreshToken,
      hits: provider.hits.length,
    };
    const expected = {
      crashed: 'store_unavailable',
      afterCrash: 'version_conflict',
      current: { accessToken: 'synthetic-access-1', version: rotatedVersion },
      storedRefreshToken: 'synthetic-refresh-1',
      liveAtProvider: 'synthetic-refresh-1',
      hits: 1,
    };
    expect(actual).toEqual(expected);
  });

  it('given the provider revoking the grant, should mark the account needs_reauth and never ask the provider again', async () => {
    const plane = planeStore();
    const seeded = await seedAccount(plane.store, plane.provisioner);
    provider.mode = 'revoked';
    const recorded = recordingAccounts();
    const worker = workerOver(plane, seeded, recorded.accounts);
    const first = await worker.ensureFresh(request(seeded));
    const second = await worker.ensureFresh(request(seeded));

    const actual = {
      first: first.ok ? 'ok' : first.reason,
      second: second.ok ? 'ok' : second.reason,
      hits: provider.hits.length,
      marked: recorded.calls.filter((call) => call.op === 'needs_reauth').length >= 1,
    };
    const expected = { first: 'needs_reauth', second: 'needs_reauth', hits: 1, marked: true };
    expect(actual).toEqual(expected);
  });

  it('given a stored token endpoint that differs from the pinned registry, should send the refresh token nowhere', async () => {
    const plane = planeStore();
    const seeded = await seedAccount(plane.store, plane.provisioner);
    const recorded = recordingAccounts();
    const worker = createRefreshWorker({
      ...{
        store: plane.store,
      },
      resolveRefreshable: ({ ref, version }) =>
        plane.provisioner.identityOf(ref.tenantId).then((tenant) => plane.store.resolve({ ref, version, grant: refreshGrant(seeded, version), identity: { tenantId: ref.tenantId, identityId: tenant?.identityId ?? '', channel: 'refresh-worker', blastRadius: 'tenant' } })),
      currentVersion: (ref) => createPlaneMetadataRepository({ pool: metadataPool as never }).read(ref).then((facts) => facts?.currentVersion ?? null),
      identityFor: async () => null,
      attempts: createRefreshAttemptRepository({ pool: metadataPool }),
      advisoryLockPool: createPlaneMetadataRepository({ pool: metadataPool as never }).advisoryLockPool,
      network: createPinnedHttpsClient({ resolveHost: async () => [{ address: '127.0.0.1', family: 4 }], isPublic: () => true, ca }),
      registry: { itest: { issuer: ISSUER, tokenEndpoint: 'https://token.refresh-itest.example/elsewhere', revocationEndpoint: null, clientAuth: 'client_secret_basic' } },
      clientFor: () => CLIENT,
      accounts: recorded.accounts,
      now: () => Date.now(),
      marginMs: 60_000,
    });
    const outcome = await worker.ensureFresh(request(seeded));

    const actual = { outcome: outcome.ok ? 'ok' : outcome.reason, hits: provider.hits.length };
    const expected = { outcome: 'needs_reauth', hits: 0 };
    expect(actual).toEqual(expected);
  });
});
