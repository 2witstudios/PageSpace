/**
 * Threat model A3 / ASI03 — a forged grant must not author audit rows.
 *
 * The audit chain is tamper-evident and non-erasable, so whatever a denial
 * row names stays named. A grant that fails signature verification is
 * attacker-authored text: if its `human`, `agentPageId` or `grantId` reached
 * the row, anyone able to reach the executor could write permanent audit
 * history accusing an arbitrary person or agent. The denial row may carry
 * only what the executor itself authenticated (the caller's channel and
 * presenter key), a SHA3-256 digest of the presented claim (so the exact
 * bytes stay provable without being stored), and the reason.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey, createHash } from 'node:crypto';
import { verifyGrant } from '../../verify-grant';
import { encodeGrant } from '../../encode-grant';
import { GRANT_ISSUER } from '../../grant-constants';
import { createAuditedExecutor } from '../../audit-gate-executor';
import type { AgentAccountAuditRecord } from '../../audit';
import type { AuditAcceptance } from '../../decide-audit-gate';
import type { AgentAccountDenialRecord } from '../../denial-audit-record';
import type {
  AgentAccountGrant,
  AgentPageId,
  ApprovalId,
  BindingDigest,
  ConversationId,
  Ed25519Verify,
  GrantId,
  HashBytes,
  Nonce,
  PresenterKeyId,
  RequestDigest,
  RunId,
  SessionId,
  UserId,
} from '../../grant';
import type { AccountId, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';

const issuer = generateKeyPairSync('ed25519');
const attacker = generateKeyPairSync('ed25519');
const issuerPublicKey = new Uint8Array(issuer.publicKey.export({ type: 'spki', format: 'der' }));
const verify: Ed25519Verify = (message, signature, publicKey) =>
  nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);
const sha256: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha3: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const NOW = 1_800_000_000_000;
const DIGEST = 'digest_x' as RequestDigest;

/** Principals the attacker wants written into permanent history. */
const FRAMED = { userId: 'user_framed_victim', agentPageId: 'page_framed_agent', grantId: 'grant_forged_story' } as const;

const forged: AgentAccountGrant = {
  grantId: FRAMED.grantId as GrantId,
  iss: GRANT_ISSUER,
  aud: 'http-executor',
  tenantId: 'user:user_framed_victim' as TenantId,
  human: { userId: FRAMED.userId as UserId, sessionId: 'session_framed' as SessionId },
  delegationId: null,
  agentPageId: FRAMED.agentPageId as AgentPageId,
  conversationId: 'conv_framed' as ConversationId,
  runId: 'run_framed' as RunId,
  sandbox: null,
  callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
  accountId: 'acct_framed' as AccountId,
  accountKind: 'api_key',
  credentialVersion: 1 as CredentialVersion,
  policyVersion: 1 as PolicyVersion,
  bindingDigest: 'bd' as BindingDigest,
  operation: { class: 'write', name: 'github.issues.create' },
  requestDigest: DIGEST,
  sessionHttp: false,
  approvalId: 'approval_framed' as ApprovalId,
  iat: NOW - 1_000,
  nbf: NOW - 1_000,
  exp: NOW + 60_000,
  nonce: 'nonce_framed' as Nonce,
  presenter: { keyId: 'pk_transport_authenticated' as PresenterKeyId, channel: 'http-executor' },
};

function recordingRepository() {
  const written: unknown[] = [];
  const accepted = async (): Promise<AuditAcceptance> => ({ kind: 'accepted' });
  return {
    written,
    repository: {
      accept: async ({ record }: { readonly record: AgentAccountAuditRecord }) => {
        written.push(record);
        return accepted();
      },
      acceptDenial: async ({ record }: { readonly record: AgentAccountDenialRecord }) => {
        written.push(record);
        return accepted();
      },
    },
  };
}

describe('forged grant → denial audit row (ASI03)', () => {
  it('given a grant signed by a key other than the issuer, should deny it bad_signature and write a denial row that names none of the principals it claims', async () => {
    const signature = Buffer.from(nodeSign(null, encodeGrant(forged), attacker.privateKey)).toString('base64');
    const verdict = verifyGrant({
      grant: forged,
      signature,
      issuerPublicKey,
      now: NOW,
      expected: {
        aud: 'http-executor',
        // The attacker presents the key the transport authenticated, so F2 passes
        // and the refusal is the signature itself.
        presenter: forged.presenter,
        human: forged.human,
        agentPageId: forged.agentPageId,
        conversationId: forged.conversationId,
        runId: forged.runId,
        tenantId: forged.tenantId,
        accountId: forged.accountId,
        accountKind: forged.accountKind,
        accountDriveId: null,
        accountStatus: 'active',
        currentCredentialVersion: forged.credentialVersion,
        currentPolicyVersion: forged.policyVersion,
        delegation: { kind: 'live_session' },
        sandbox: null,
        ceilingAdmitsAccount: true,
      },
      requestDigest: DIGEST,
      requestOperation: forged.operation,
      nonceState: 'fresh',
      approval: { kind: 'concrete', approvalId: 'approval_framed' as ApprovalId, accountId: forged.accountId, requestDigest: DIGEST, consumedByGrantId: forged.grantId, expiresAt: NOW + 120_000 },
      verify,
      hash: sha256,
    });
    if (verdict.ok) throw new Error('a forged grant verified');

    const { repository, written } = recordingRepository();
    const executor = createAuditedExecutor({ auditRepository: repository, hash: sha3 });
    const claim = new TextEncoder().encode(JSON.stringify({ grant: forged, signature }));
    await executor.recordDenial({
      caller: { channel: 'http-executor', presenterKeyId: 'pk_transport_authenticated' as PresenterKeyId },
      claim,
      reason: verdict.reason,
      now: NOW,
    });

    const serialized = JSON.stringify(written);
    const actual = {
      reason: verdict.reason,
      rows: written.length,
      framed: Object.values(FRAMED).filter((value) => serialized.includes(value)),
      claimDigestPresent: serialized.includes(sha3(claim)),
    };
    const expected = { reason: 'bad_signature', rows: 1, framed: [], claimDigestPresent: true };
    expect(actual).toEqual(expected);
  });
});
