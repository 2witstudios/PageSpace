/**
 * ADR 0004 §8.11 (adapter half) — the nonce is recorded ONLY when the whole
 * verdict is `ok`, against the REAL replay ledger on :5433.
 *
 * Written RED at G1b before `grant-gate-executor.ts` existed. The gate is
 * the one I/O shell around the pure verifier: look the nonce up, verify,
 * and consume only on `ok`. Two gates over one database are two replicas.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';
import { agentAccountGrantNonces } from '@pagespace/db/schema/agent-account-grant-nonces';
import { requireDb } from '@pagespace/db/test/require-db';
import { createReplayStoreRepository } from '../replay-store-repository';
import { createGrantGate } from '../grant-gate-executor';
import { encodeGrant } from '../encode-grant';
import { GRANT_ISSUER } from '../grant-constants';
import type {
  AgentAccountGrant,
  AgentPageId,
  ApprovalId,
  BindingDigest,
  ConversationId,
  DriveId,
  Ed25519Verify,
  ExpectedBinding,
  GrantId,
  HashBytes,
  Nonce,
  PresenterKeyId,
  RequestDigest,
  RunId,
  SessionId,
  UserId,
} from '../grant';
import type { AccountId, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';

const issuer = generateKeyPairSync('ed25519');
const rogue = generateKeyPairSync('ed25519');
const issuerPublicKey = new Uint8Array(issuer.publicKey.export({ type: 'spki', format: 'der' }));
const verify: Ed25519Verify = (message, signature, publicKey) =>
  nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);
const hash: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

const PREFIX = 'itest-gate-';
const NOW = Date.now();
let seq = 0;
let dbAvailable = false;

function grantWith(nonce: Nonce): AgentAccountGrant {
  return {
    grantId: `${PREFIX}grant-${nonce}` as GrantId,
    iss: GRANT_ISSUER,
    aud: 'http-executor',
    tenantId: 'user:u1' as TenantId,
    human: { userId: 'u1' as UserId, sessionId: 's1' as SessionId },
    delegationId: null,
    agentPageId: 'p1' as AgentPageId,
    conversationId: 'c1' as ConversationId,
    runId: 'r1' as RunId,
    sandbox: null,
    callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
    accountId: 'a1' as AccountId,
    accountKind: 'api_key',
    credentialVersion: 1 as CredentialVersion,
    policyVersion: 1 as PolicyVersion,
    bindingDigest: 'bd' as BindingDigest,
    operation: { class: 'read', name: 'op' },
    requestDigest: 'rd' as RequestDigest,
    sessionHttp: false,
    approvalId: 'policy',
    iat: NOW - 1_000,
    nbf: NOW - 1_000,
    exp: NOW + 60_000,
    nonce,
    presenter: { keyId: 'pk' as PresenterKeyId, channel: 'http-executor' },
  };
}

const expectedFor = (grant: AgentAccountGrant): ExpectedBinding => ({
  aud: grant.aud,
  presenter: grant.presenter,
  human: grant.human,
  agentPageId: grant.agentPageId,
  conversationId: grant.conversationId,
  runId: grant.runId,
  tenantId: grant.tenantId,
  accountId: grant.accountId,
  accountKind: grant.accountKind,
  accountDriveId: 'd1' as DriveId,
  accountStatus: 'active',
  currentCredentialVersion: grant.credentialVersion,
  previousCredentialVersion: null,
  rotatedAt: null,
  currentPolicyVersion: grant.policyVersion,
  delegation: { kind: 'live_session' },
  sandbox: null,
  ceilingAdmitsAccount: true,
});

const sign = (grant: AgentAccountGrant, key: typeof issuer.privateKey = issuer.privateKey) => Buffer.from(nodeSign(null, encodeGrant(grant), key)).toString('base64');

function presentation(grant: AgentAccountGrant, signature = sign(grant)) {
  return {
    grant,
    signature,
    issuerPublicKey,
    now: NOW,
    expected: expectedFor(grant),
    requestDigest: grant.requestDigest,
    requestOperation: grant.operation,
    approval: { kind: 'policy' as const, policyVersion: grant.policyVersion, expired: false, limitsExceeded: false },
    verify,
    hash,
    rotationGraceMs: 300_000,
  };
}

const freshNonce = (): Nonce => {
  seq += 1;
  return `${PREFIX}${NOW}-${seq}` as Nonce;
};

async function clearRows() {
  await db.delete(agentAccountGrantNonces).where(sql`${agentAccountGrantNonces.nonce} LIKE ${`${PREFIX}%`}`);
}

beforeAll(async () => {
  try {
    await db.execute(sql`SELECT 1`);
    dbAvailable = true;
    await clearRows();
  } catch (error) {
    requireDb('grant-gate-executor.integration.test.ts', error);
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (dbAvailable) await clearRows();
});

describe('grant gate — nonce recorded only on ok (ADR 0004 §8.11)', () => {
  it('given a grant failing bad_signature, should leave the replay store untouched and a later valid presentation should succeed', async () => {
    if (!dbAvailable) return;
    const store = createReplayStoreRepository({ db });
    const gate = createGrantGate({ replayStore: store });
    const grant = grantWith(freshNonce());
    const forged = await gate.present(presentation(grant, sign(grant, rogue.privateKey)));
    const afterForged = await store.lookup({ nonce: grant.nonce });
    const legitimate = await gate.present(presentation(grant));
    expect({ forged, afterForged, legitimate }).toEqual({
      forged: { ok: false, reason: 'bad_signature' },
      afterForged: { ok: true, recorded: null },
      legitimate: { ok: true, grant },
    });
  });

  it('given a grant failing an earlier structural check (malformed), should not even look the nonce up', async () => {
    if (!dbAvailable) return;
    const store = createReplayStoreRepository({ db });
    const gate = createGrantGate({ replayStore: store });
    const grant = grantWith(freshNonce());
    const { grantId: _g, ...malformed } = grant;
    const verdict = await gate.present({ ...presentation(grant), grant: malformed });
    const after = await store.lookup({ nonce: grant.nonce });
    expect({ verdict, after }).toEqual({ verdict: { ok: false, reason: 'malformed' }, after: { ok: true, recorded: null } });
  });

  it('given a grant verifying ok, should record the nonce exactly once and refuse the same grant afterwards with replayed', async () => {
    if (!dbAvailable) return;
    const store = createReplayStoreRepository({ db });
    const gate = createGrantGate({ replayStore: store });
    const grant = grantWith(freshNonce());
    const first = await gate.present(presentation(grant));
    const recorded = await store.lookup({ nonce: grant.nonce });
    const second = await gate.present(presentation(grant));
    expect({ first, recordedGrantId: recorded.ok && recorded.recorded?.grantId, second }).toEqual({
      first: { ok: true, grant },
      recordedGrantId: grant.grantId,
      second: { ok: false, reason: 'replayed' },
    });
  });

  it('given one grant presented to two gate replicas concurrently, should return ok exactly once and replayed for the other', async () => {
    if (!dbAvailable) return;
    const grant = grantWith(freshNonce());
    const gates = [createGrantGate({ replayStore: createReplayStoreRepository({ db }) }), createGrantGate({ replayStore: createReplayStoreRepository({ db }) })];
    const verdicts = await Promise.all(gates.map((gate) => gate.present(presentation(grant))));
    const actual = { ok: verdicts.filter((v) => v.ok).length, replayed: verdicts.filter((v) => !v.ok && v.reason === 'replayed').length };
    expect(actual).toEqual({ ok: 1, replayed: 1 });
  });

  it('given the replay store unreachable, should return replay_store_unavailable and never ok', async () => {
    if (!dbAvailable) return;
    const deadPool = new Pool({ connectionString: 'postgresql://user:password@127.0.0.1:1/pagespace_dead', connectionTimeoutMillis: 500 });
    const gate = createGrantGate({ replayStore: createReplayStoreRepository({ db: drizzle(deadPool) }) });
    const actual = await gate.present(presentation(grantWith(freshNonce())));
    await deadPool.end();
    expect(actual).toEqual({ ok: false, reason: 'replay_store_unavailable' });
  });
});
