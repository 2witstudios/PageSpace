/**
 * `startCredentialPlane` — wires the credential plane process (L2·G2; ADR 0005
 * §3.4, §7) from its parsed configuration and listens. I/O only.
 *
 * The plane is the ONLY process that holds: the per-tenant Infisical
 * provisioner credential, the plane metadata DB, the pending-write HMAC key,
 * and (minted per operation, in memory) the tenant identities' client
 * secrets. It also reaches the main DB for the facts it compares against the
 * signed grant, the grant-nonce ledger and the audit chain.
 *
 * NOT exported from any `packages/lib` subpath (ADR 0005 F13): the web process
 * cannot import the plane; it reaches it over HTTP with `createPlaneClient`.
 * Run with `bun run --filter @pagespace/lib credential-plane`.
 */
import { createServer, type Server } from 'node:http';
import { lookup } from 'node:dns/promises';
import { createHash, createHmac, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { Pool } from 'pg';
import { db } from '@pagespace/db/db';
import type { Ed25519Verify, HashBytes } from '../grant';
import type { PlaneConfig } from './parse-plane-env';
import { isPublicIp } from '../../security/web-fetch-ssrf';
import { createSecurityAuditRepository } from '../../audit/security-audit-repository';
import { createInfisicalClient } from '../store/infisical-client';
import { createPlaneMetadataRepository } from '../store/plane-metadata-repository';
import { createInfisicalStoreAdapter } from '../store/store-adapter-infisical';
import { createConsentLedgerRepository } from '../store/consent-ledger-repository';
import { createInfisicalTenantProvisioner } from '../store/infisical-tenant-provisioner-client';
import { createReplayStoreRepository } from '../replay-store-repository';
import { createGrantGate } from '../grant-gate-executor';
import { createAgentAccountAuditRepository } from '../audit-repository';
import { createAuditedExecutor } from '../audit-gate-executor';
import { createAgentAccountRepository } from '../agent-account-repository';
import { createPinnedHttpsClient, DEFAULT_PINNED_HTTPS_LIMITS } from './pinned-https-client';
import { createHttpRequestExecutor } from './http-request-executor';
import { createPlaneRequestHandler } from './plane-http-adapter';

const sha3: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const sha256: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const verifyEd25519: Ed25519Verify = (message, signature, publicKey) => {
  try {
    return nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);
  } catch {
    return false;
  }
};
/** What the executor may release toward a model, per response. */
const MAX_RELEASED_BODY_BYTES = 256 * 1024;
const DNS_TIMEOUT_MS = 5_000;

export async function startCredentialPlane({ config }: { readonly config: PlaneConfig }): Promise<Server> {
  const metadataPool = new Pool({ connectionString: config.metadataDatabaseUrl });
  const metadata = createPlaneMetadataRepository({ pool: metadataPool as never });
  const provisioner = createInfisicalTenantProvisioner({ baseUrl: config.infisicalUrl, organizationId: config.infisicalOrgId, auth: config.provisioner, pool: metadataPool, advisoryLockPool: metadata.advisoryLockPool });
  const store = createInfisicalStoreAdapter({
    infisical: createInfisicalClient({ baseUrl: config.infisicalUrl, environment: config.infisicalEnvironment }),
    metadata,
    advisoryLockPool: metadata.advisoryLockPool,
    resolveProject: (tenantId) => provisioner.projectOf(tenantId),
    resolveCredentials: (input) => provisioner.credentialsFor(input),
    hash: sha3,
    writeDigestKey: config.writeDigestKey,
    hmac: (key, bytes) => createHmac('sha3-256', key).update(bytes).digest('hex'),
    now: () => Date.now(),
    consentPublicKey: config.consentPublicKey ?? new Uint8Array(0),
    verify: verifyEd25519,
    consentLedger: createConsentLedgerRepository({ pool: metadataPool }),
  });
  const executor = createHttpRequestExecutor({
    store,
    provisioner,
    accounts: createAgentAccountRepository({ db }),
    grantGate: createGrantGate({ replayStore: createReplayStoreRepository({ db }) }),
    audited: createAuditedExecutor({ auditRepository: createAgentAccountAuditRepository({ appendPath: createSecurityAuditRepository({ db }) }), hash: sha3 }),
    network: createPinnedHttpsClient({
      // DNS gets its own deadline: the pinned client's timer starts only at connect (review HIGH-2).
      resolveHost: async (hostname) => {
        const answers = await Promise.race([
          lookup(hostname, { all: true, verbatim: true }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS)),
        ]);
        return answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }));
      },
      isPublic: isPublicIp,
      limits: DEFAULT_PINNED_HTTPS_LIMITS,
    }),
    registry: [],
    issuerPublicKey: config.authorityPublicKey,
    presenterKeyId: config.presenterKeyId,
    verify: verifyEd25519,
    hash: sha3,
    sha256,
    now: () => Date.now(),
    rotationGraceMs: 300_000,
    maxReleasedBodyBytes: MAX_RELEASED_BODY_BYTES,
  });
  const server = createServer(
    createPlaneRequestHandler({
      secret: config.serviceSecret,
      store,
      provisioner,
      executor,
      hmac: (key, text) => createHmac('sha256', key).update(text).digest('hex'),
      sha256,
      now: () => Date.now(),
    }),
  );
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  server.on('close', () => {
    void metadataPool.end();
  });
  return server;
}
