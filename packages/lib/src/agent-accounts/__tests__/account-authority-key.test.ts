/**
 * ADR 0004 §2.2 — the account authority signs under its OWN key, with its
 * own environment variable, its own issuer and its own audience, so a bridge
 * grant can never verify as an account grant and vice versa.
 *
 * Written RED at G1b before `account-authority-key.ts` and `sign-grant.ts`
 * existed. The rule inherited from `auth/env-bridge-signing-key.ts`: an
 * UNSET key is a refusal, never an ephemeral fallback — a server that signed
 * with a key nothing pinned would be issuing grants nothing can verify, and
 * one that generated its own would be trusting itself.
 */
import { describe, it, expect } from 'vitest';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, type KeyObject } from 'node:crypto';
import {
  parseAccountAuthorityKeyring,
  ACCOUNT_AUTHORITY_SIGNING_KEY_VAR,
  ACCOUNT_AUTHORITY_SIGNING_KEYS_VAR,
  type AuthorityKeyPrimitives,
} from '../account-authority-key';
import { signGrant } from '../sign-grant';
import { verifyGrant } from '../verify-grant';
import { encodeGrant } from '../encode-grant';
import { GRANT_ISSUER } from '../grant-constants';
import { ENV_BRIDGE_SIGNING_KEY_VAR } from '../../env-bridge/server-signing-key';
import { verifyGrant as verifyBridgeGrant, createMemoryNonceStore } from '../../env-bridge/grant';
import type {
  AgentAccountGrant,
  AgentPageId,
  ApprovalId,
  BindingDigest,
  ConversationId,
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
  DriveId,
} from '../grant';
import type { AccountId, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';

const primitives: AuthorityKeyPrimitives = {
  importPrivateKey: (pkcs8) => {
    try {
      const privateKey = createPrivateKey({ key: Buffer.from(pkcs8), type: 'pkcs8', format: 'der' });
      if (privateKey.asymmetricKeyType !== 'ed25519') return null;
      const publicKey = new Uint8Array(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }));
      return { publicKey, sign: (message) => new Uint8Array(nodeSign(null, message, privateKey)) };
    } catch {
      return null;
    }
  },
  hash: (bytes) => createHash('sha256').update(bytes).digest('hex'),
};

const pkcs8 = (pair: { privateKey: KeyObject }): string =>
  Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'der' })).toString('base64');

const keyA = generateKeyPairSync('ed25519');
const keyB = generateKeyPairSync('ed25519');
const bridgeKey = generateKeyPairSync('ed25519');

const verify: Ed25519Verify = (message, signature, publicKey) =>
  nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);
const hash: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

const NOW = 1_800_000_000_000;

function makeGrant(): AgentAccountGrant {
  return {
    grantId: 'grant_1' as GrantId,
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
    operation: { class: 'read', name: 'github.issues.list' },
    requestDigest: 'rd' as RequestDigest,
    sessionHttp: false,
    approvalId: 'approval_1' as ApprovalId,
    iat: NOW - 1_000,
    nbf: NOW - 1_000,
    exp: NOW + 60_000,
    nonce: 'n1' as Nonce,
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

describe('parseAccountAuthorityKeyring (ADR 0004 §2.2)', () => {
  it('given its own environment variable names, should be distinct from the env-bridge key variable', () => {
    const actual = [ACCOUNT_AUTHORITY_SIGNING_KEY_VAR, ACCOUNT_AUTHORITY_SIGNING_KEYS_VAR].includes(ENV_BRIDGE_SIGNING_KEY_VAR);
    expect(actual).toBe(false);
  });

  it('given a single base64 PKCS#8 Ed25519 key, should return a ring of one whose keyId derives from the public half', () => {
    const verdict = parseAccountAuthorityKeyring({ single: pkcs8(keyA), multi: undefined }, primitives);
    const expectedId = primitives.hash(new Uint8Array(keyA.publicKey.export({ type: 'spki', format: 'der' }))).slice(0, 16);
    expect(verdict.ok && { keyIds: verdict.keyring.keyIds, currentId: verdict.keyring.current.keyId }).toEqual({ keyIds: [expectedId], currentId: expectedId });
  });

  it('given the rotation form, should take the first key as current and serve every listed key by id', () => {
    const verdict = parseAccountAuthorityKeyring({ single: undefined, multi: `${pkcs8(keyA)}, ${pkcs8(keyB)}` }, primitives);
    if (!verdict.ok) throw new Error('expected ok');
    const [idA, idB] = verdict.keyring.keyIds;
    expect({
      count: verdict.keyring.keyIds.length,
      currentIsFirst: verdict.keyring.current.keyId === idA,
      servesSecond: verdict.keyring.get(idB!)?.keyId === idB,
      unknown: verdict.keyring.get('not-a-key-id'),
    }).toEqual({ count: 2, currentIsFirst: true, servesSecond: true, unknown: null });
  });

  it('given both variables set, should let the rotation list win', () => {
    const verdict = parseAccountAuthorityKeyring({ single: pkcs8(keyA), multi: pkcs8(keyB) }, primitives);
    const expectedId = primitives.hash(new Uint8Array(keyB.publicKey.export({ type: 'spki', format: 'der' }))).slice(0, 16);
    expect(verdict.ok && verdict.keyring.current.keyId).toBe(expectedId);
  });

  it('given no key at all, should refuse with unset — never an ephemeral fallback', () => {
    const actual = [
      parseAccountAuthorityKeyring({ single: undefined, multi: undefined }, primitives),
      parseAccountAuthorityKeyring({ single: '   ', multi: '' }, primitives),
    ];
    expect(actual).toEqual([{ ok: false, reason: 'unset' }, { ok: false, reason: 'unset' }]);
  });

  it.each([
    ['not base64', 'not base64!!'],
    ['base64 of junk', Buffer.from('nonsense').toString('base64')],
  ])('given a %s key, should refuse with malformed naming the entry', (_label, value) => {
    const actual = parseAccountAuthorityKeyring({ single: value, multi: undefined }, primitives);
    expect(actual).toEqual({ ok: false, reason: 'malformed', index: 0 });
  });

  it('given an RSA key instead of Ed25519, should refuse with malformed (strict algorithm allowlist)', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const der = Buffer.from(rsa.privateKey.export({ type: 'pkcs8', format: 'der' })).toString('base64');
    const actual = parseAccountAuthorityKeyring({ single: der, multi: undefined }, primitives);
    expect(actual).toEqual({ ok: false, reason: 'malformed', index: 0 });
  });

  it('given one bad entry in a list, should refuse the WHOLE ring naming its index (a partial ring strands pinned grants)', () => {
    const actual = parseAccountAuthorityKeyring({ single: undefined, multi: `${pkcs8(keyA)},nonsense` }, primitives);
    expect(actual).toEqual({ ok: false, reason: 'malformed', index: 1 });
  });

  it('given the same key listed twice, should refuse with duplicate_key naming the index', () => {
    const actual = parseAccountAuthorityKeyring({ single: undefined, multi: `${pkcs8(keyA)},${pkcs8(keyA)}` }, primitives);
    expect(actual).toEqual({ ok: false, reason: 'duplicate_key', index: 1 });
  });
});

describe('signGrant (ADR 0004 §2.2)', () => {
  it('given a grant signed by the authority key, should verify ok under that key', () => {
    const verdict = parseAccountAuthorityKeyring({ single: pkcs8(keyA), multi: undefined }, primitives);
    if (!verdict.ok) throw new Error('expected ok');
    const grant = makeGrant();
    const signature = signGrant({ grant, key: verdict.keyring.current });
    const actual = verifyGrant({
      grant,
      signature,
      issuerPublicKey: verdict.keyring.current.publicKey,
      now: NOW,
      expected: expectedFor(grant),
      requestDigest: grant.requestDigest,
      requestOperation: grant.operation,
      nonceState: 'fresh',
      approval: { kind: 'concrete', approvalId: grant.approvalId as ApprovalId, accountId: grant.accountId, requestDigest: grant.requestDigest, consumedByGrantId: grant.grantId, expiresAt: grant.exp },
      verify,
      hash,
      rotationGraceMs: 300_000,
    });
    expect(actual).toEqual({ ok: true, grant });
  });

  it('given a grant signed by a ROTATED-OUT key, should not verify under the current key', () => {
    const verdict = parseAccountAuthorityKeyring({ single: undefined, multi: `${pkcs8(keyA)},${pkcs8(keyB)}` }, primitives);
    if (!verdict.ok) throw new Error('expected ok');
    const grant = makeGrant();
    const previous = verdict.keyring.get(verdict.keyring.keyIds[1]!)!;
    const actual = verifyGrant({
      grant,
      signature: signGrant({ grant, key: previous }),
      issuerPublicKey: verdict.keyring.current.publicKey,
      now: NOW,
      expected: expectedFor(grant),
      requestDigest: grant.requestDigest,
      requestOperation: grant.operation,
      nonceState: 'fresh',
      approval: { kind: 'concrete', approvalId: grant.approvalId as ApprovalId, accountId: grant.accountId, requestDigest: grant.requestDigest, consumedByGrantId: grant.grantId, expiresAt: grant.exp },
      verify,
      hash,
      rotationGraceMs: 300_000,
    });
    expect(actual).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given the signature, should be base64 over encodeGrant bytes and nothing else', () => {
    const verdict = parseAccountAuthorityKeyring({ single: pkcs8(keyA), multi: undefined }, primitives);
    if (!verdict.ok) throw new Error('expected ok');
    const grant = makeGrant();
    const signature = signGrant({ grant, key: verdict.keyring.current });
    const actual = verify(encodeGrant(grant), Buffer.from(signature, 'base64'), verdict.keyring.current.publicKey);
    expect(actual).toBe(true);
  });
});

describe('the two authorities are separate (ADR 0004 §9)', () => {
  it('given an account grant presented to the env-bridge gate, should be malformed there (different shape, different authority)', () => {
    const grant = makeGrant();
    const actual = verifyBridgeGrant({
      grant,
      signature: Buffer.from(nodeSign(null, encodeGrant(grant), bridgeKey.privateKey)).toString('base64'),
      serverPublicKey: new Uint8Array(bridgeKey.publicKey.export({ type: 'spki', format: 'der' })),
      now: NOW,
      nonces: createMemoryNonceStore(),
      expectedEnvId: 'env_1',
      request: { op: 'exec', args: { cmd: 'ls', args: [], cwd: null, env: {}, timeoutMs: null, maxBytes: null } },
      verify,
      hash,
    });
    expect(actual).toEqual({ ok: false, reason: 'malformed' });
  });

  it('given an env-bridge grant presented to the account verifier, should be malformed here', () => {
    const bridgeGrant = {
      grantId: 'g1',
      envId: 'env_1',
      principal: { userId: 'u1', sessionId: 's1', conversationId: 'c1' },
      op: 'exec',
      argsHash: 'abc',
      iat: NOW - 1_000,
      exp: NOW + 30_000,
      nonce: 'n1',
    };
    const grant = makeGrant();
    const actual = verifyGrant({
      grant: bridgeGrant,
      signature: Buffer.from(nodeSign(null, new TextEncoder().encode(JSON.stringify(bridgeGrant)), bridgeKey.privateKey)).toString('base64'),
      issuerPublicKey: new Uint8Array(bridgeKey.publicKey.export({ type: 'spki', format: 'der' })),
      now: NOW,
      expected: expectedFor(grant),
      requestDigest: grant.requestDigest,
      requestOperation: grant.operation,
      nonceState: 'fresh',
      approval: { kind: 'none' },
      verify,
      hash,
      rotationGraceMs: 300_000,
    });
    expect(actual).toEqual({ ok: false, reason: 'malformed' });
  });
});
