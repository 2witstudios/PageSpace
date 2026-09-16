/**
 * ADR 0004 §8 assertions 1–12, 19–24 and ADR 0006 §8.1–4 — the grant
 * verifier as a pure function in fixed deny order (Control Board §7.2).
 *
 * Written RED at G1b before `parse-grant.ts`, `encode-grant.ts`,
 * `verify-grant.ts`, `decide-sandbox-binding.ts` and `collapse-verdict.ts`
 * existed. Real Ed25519 keys and a real SHA-256 exercise the crypto for
 * real, but both primitives are INJECTED — the verifier never touches
 * `node:crypto` and never reads a clock.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey, createHash } from 'node:crypto';
import { parseGrant } from '../parse-grant';
import { verifyGrant } from '../verify-grant';
import { encodeGrant } from '../encode-grant';
import { decideSandboxBinding } from '../decide-sandbox-binding';
import { collapseVerdictForCaller } from '../collapse-verdict';
import { GRANT_ISSUER, GRANT_LIMITS } from '../grant-constants';
import { canonicalizeRequest } from '../canonicalize-request';
import { digestRequest } from '../digest-request';
import type {
  AgentAccountGrant,
  ApprovalFact,
  ApprovalId,
  AgentPageId,
  BindingDigest,
  ConversationId,
  DelegationId,
  DriveId,
  Ed25519Verify,
  ExpectedBinding,
  GrantDenyReason,
  GrantId,
  HashBytes,
  Nonce,
  NonceState,
  OperationRef,
  PresenterChannel,
  PresenterKeyId,
  RequestDigest,
  RunId,
  SandboxGeneration,
  SandboxInstanceId,
  SessionId,
  SpriteName,
  UserId,
  VerifyGrantInput,
} from '../grant';
import type { AccountId, AccountKind, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type { CanonicalRequestInput } from '../canonical-request';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const issuer = generateKeyPairSync('ed25519');
const envBridge = generateKeyPairSync('ed25519');
const issuerPublicKey = new Uint8Array(issuer.publicKey.export({ type: 'spki', format: 'der' }));

const verify: Ed25519Verify = (message, signature, publicKey) =>
  nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);
const hash: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

function signWith(privateKey: typeof issuer.privateKey, grant: AgentAccountGrant): string {
  return Buffer.from(nodeSign(null, encodeGrant(grant), privateKey)).toString('base64');
}

const NOW = 1_800_000_000_000;
const DRIVE = 'drive_1' as DriveId;

const REQUEST_INPUT: CanonicalRequestInput = {
  channel: 'http-executor',
  method: 'POST',
  url: 'https://api.github.com/repos/octo/hello/issues',
  headers: { accept: 'application/json' },
  body: new TextEncoder().encode('{"title":"hello"}'),
  resources: { repo: 'octo/hello' },
  operation: { class: 'write', name: 'github.issues.create' },
  declaredHeaders: [],
};

function digestOf(input: CanonicalRequestInput): RequestDigest {
  const result = canonicalizeRequest(input);
  if (!result.ok) throw new Error(result.reason);
  return digestRequest({ canonical: result.canonical, hash });
}

const REQUEST_DIGEST = digestOf(REQUEST_INPUT);
const OPERATION: OperationRef = { class: 'write', name: 'github.issues.create' };

/** Approval rows outlive issuance in the default fixtures; §8.31 cases move this. */
const APPROVAL_EXPIRES_AT = NOW + 120_000;

const SANDBOX = { spriteName: 'ws-abc' as SpriteName, instanceId: 'sprite-111' as SandboxInstanceId, generation: 3 as SandboxGeneration };

function makeGrant(overrides: Partial<AgentAccountGrant> = {}): AgentAccountGrant {
  const aud: PresenterChannel = overrides.aud ?? 'http-executor';
  return {
    grantId: 'grant_1' as GrantId,
    iss: GRANT_ISSUER,
    aud,
    tenantId: 'user:user_1' as TenantId,
    human: { userId: 'user_1' as UserId, sessionId: 'session_1' as SessionId },
    delegationId: null,
    agentPageId: 'page_agent_1' as AgentPageId,
    conversationId: 'conv_1' as ConversationId,
    runId: 'run_1' as RunId,
    sandbox: aud === 'relay-runner' ? SANDBOX : null,
    callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
    accountId: 'acct_1' as AccountId,
    accountKind: 'api_key',
    credentialVersion: 4 as CredentialVersion,
    policyVersion: 7 as PolicyVersion,
    bindingDigest: 'bd_1' as BindingDigest,
    operation: OPERATION,
    requestDigest: REQUEST_DIGEST,
    sessionHttp: false,
    approvalId: 'approval_1' as ApprovalId,
    iat: NOW - 1_000,
    nbf: NOW - 1_000,
    exp: NOW + 60_000,
    nonce: 'nonce_1' as Nonce,
    presenter: { keyId: 'pk_exec_1' as PresenterKeyId, channel: aud },
    ...overrides,
  };
}

function ceilingAdmits(allowed: readonly string[], driveId: DriveId | null): boolean {
  return allowed.length === 0 || (driveId !== null && allowed.includes(driveId));
}

function expectedFor(grant: AgentAccountGrant, overrides: Partial<ExpectedBinding> = {}): ExpectedBinding {
  return {
    aud: grant.aud,
    presenter: grant.presenter,
    human: grant.human,
    agentPageId: grant.agentPageId,
    conversationId: grant.conversationId,
    runId: grant.runId,
    tenantId: grant.tenantId,
    accountId: grant.accountId,
    accountKind: grant.accountKind,
    accountStatus: 'active',
    accountDriveId: DRIVE,
    currentCredentialVersion: grant.credentialVersion,
    currentPolicyVersion: grant.policyVersion,
    delegation:
      grant.delegationId === null
        ? { kind: 'live_session' }
        : { kind: 'delegation', delegationId: grant.delegationId, accountId: grant.accountId, agentPageId: grant.agentPageId, delegatedBy: grant.human.userId, expired: false, revoked: false },
    // Optional chaining on purpose: the field-absent table feeds grants with fields removed.
    sandbox: grant.sandbox == null ? null : { spriteName: grant.sandbox.spriteName, instanceId: grant.sandbox.instanceId, generation: grant.sandbox.generation },
    ceilingAdmitsAccount: ceilingAdmits(grant.callerCeiling?.allowedDriveIds ?? [], DRIVE),
    ...overrides,
  };
}

function approvalFor(grant: AgentAccountGrant): ApprovalFact {
  if (grant.approvalId === 'policy') return { kind: 'policy', policyVersion: grant.policyVersion, expired: false, limitsExceeded: false };
  return { kind: 'concrete', approvalId: grant.approvalId, accountId: grant.accountId, requestDigest: grant.requestDigest, consumedByGrantId: grant.grantId, expiresAt: APPROVAL_EXPIRES_AT };
}

type RunOpts = {
  signature?: string;
  now?: number;
  expected?: Partial<ExpectedBinding>;
  requestDigest?: RequestDigest;
  requestOperation?: OperationRef;
  nonceState?: NonceState;
  approval?: ApprovalFact;
  verify?: Ed25519Verify;
  issuerPublicKey?: Uint8Array;
};

function run(grant: unknown, opts: RunOpts = {}) {
  const typed = grant as AgentAccountGrant;
  return verifyGrant({
    grant,
    signature: opts.signature ?? signWith(issuer.privateKey, typed),
    issuerPublicKey: opts.issuerPublicKey ?? issuerPublicKey,
    now: opts.now ?? NOW,
    expected: expectedFor(typed, opts.expected),
    requestDigest: opts.requestDigest ?? REQUEST_DIGEST,
    requestOperation: opts.requestOperation ?? OPERATION,
    nonceState: opts.nonceState ?? 'fresh',
    approval: opts.approval ?? approvalFor(typed),
    verify: opts.verify ?? verify,
    hash,
  });
}

const deny = (reason: GrantDenyReason) => ({ ok: false as const, reason });

/** A concrete approval fact for the default grant, with the M3 fields filled in; override what a case varies. */
const concreteFact = (overrides: Partial<Extract<ApprovalFact, { kind: 'concrete' }>> = {}): ApprovalFact => ({
  kind: 'concrete',
  approvalId: 'approval_1' as ApprovalId,
  accountId: 'acct_1' as AccountId,
  requestDigest: REQUEST_DIGEST,
  consumedByGrantId: 'grant_1' as GrantId,
  expiresAt: APPROVAL_EXPIRES_AT,
  ...overrides,
});

// ---------------------------------------------------------------------------
// parseGrant (F1)
// ---------------------------------------------------------------------------

describe('parseGrant (ADR 0004 F1)', () => {
  it('given a well-formed grant, should return ok with the typed grant', () => {
    const grant = makeGrant();
    const actual = parseGrant({ grant });
    expect(actual).toEqual({ ok: true, grant });
  });

  it.each(Object.keys(makeGrant()) as (keyof AgentAccountGrant)[])(
    'given the field %s absent, should return malformed before any other check runs (no signature call observed) [0004 §8.1]',
    (field) => {
      const spy = vi.fn<Ed25519Verify>(() => true);
      const { [field]: _dropped, ...without } = makeGrant();
      const parsed = parseGrant({ grant: without });
      const verdict = run(without, { verify: spy, signature: 'AAAA' });
      expect({ parsed, verdict, verifyCalls: spy.mock.calls.length }).toEqual({ parsed: deny('malformed'), verdict: deny('malformed'), verifyCalls: 0 });
    },
  );

  it('given a field set to undefined, should return malformed [0004 §8.1]', () => {
    const actual = parseGrant({ grant: { ...makeGrant(), runId: undefined } });
    expect(actual).toEqual(deny('malformed'));
  });

  it('given an extra key (a privileged-looking rider), should return malformed [0004 §8.1]', () => {
    const actual = parseGrant({ grant: { ...makeGrant(), isAdmin: true } });
    expect(actual).toEqual(deny('malformed'));
  });

  it('given a nested extra key, should return malformed', () => {
    const grant = makeGrant();
    const actual = parseGrant({ grant: { ...grant, human: { ...grant.human, role: 'owner' } } });
    expect(actual).toEqual(deny('malformed'));
  });

  it('given exp < iat, should return malformed, not ttl_too_long [0004 §8.2]', () => {
    const actual = run(makeGrant({ iat: NOW, nbf: NOW, exp: NOW - 1 }));
    expect(actual).toEqual(deny('malformed'));
  });

  it('given nbf > iat, should return malformed [0004 F1]', () => {
    const actual = run(makeGrant({ iat: NOW - 1_000, nbf: NOW, exp: NOW + 60_000 }));
    expect(actual).toEqual(deny('malformed'));
  });

  it('given aud relay-runner with sandbox null, should return malformed [0006 §8.1]', () => {
    const actual = parseGrant({ grant: makeGrant({ aud: 'relay-runner', sandbox: null, presenter: { keyId: 'pk' as PresenterKeyId, channel: 'relay-runner' } }) });
    expect(actual).toEqual(deny('malformed'));
  });

  it('given sandbox set with any other aud, should return malformed [0006 §8.1]', () => {
    const actual = parseGrant({ grant: makeGrant({ aud: 'http-executor', sandbox: SANDBOX }) });
    expect(actual).toEqual(deny('malformed'));
  });

  it('given a grant without bindingDigest or sessionHttp, should return malformed (every field required) [0004 §8.24]', () => {
    const { bindingDigest: _b, ...noBinding } = makeGrant();
    const { sessionHttp: _s, ...noSession } = makeGrant();
    const actual = [parseGrant({ grant: noBinding }), parseGrant({ grant: noSession })];
    expect(actual).toEqual([deny('malformed'), deny('malformed')]);
  });

  it('given sessionHttp true on a kind other than session or a channel other than http-executor, should return malformed (always false elsewhere)', () => {
    const actual = [
      parseGrant({ grant: makeGrant({ accountKind: 'api_key', sessionHttp: true }) }),
      parseGrant({ grant: makeGrant({ aud: 'browser-worker', presenter: { keyId: 'pk' as PresenterKeyId, channel: 'browser-worker' }, accountKind: 'session', sessionHttp: true }) }),
    ];
    expect(actual).toEqual([deny('malformed'), deny('malformed')]);
  });

  it('given an operation class outside the union or a method-shaped iss, should return malformed', () => {
    const actual = [
      parseGrant({ grant: { ...makeGrant(), operation: { class: 'admin', name: 'x' } } }),
      parseGrant({ grant: { ...makeGrant(), iss: 'pagespace-env-bridge' } }),
    ];
    expect(actual).toEqual([deny('malformed'), deny('malformed')]);
  });

  it('given a RunId where a SandboxInstanceId is expected, should fail typecheck (@ts-expect-error brand test) [0004 §8.3]', () => {
    const runId = 'run_1' as RunId;
    // @ts-expect-error — a RunId is not a SandboxInstanceId (brand separation)
    const instanceId: SandboxInstanceId = runId;
    expect(typeof instanceId).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// encodeGrant
// ---------------------------------------------------------------------------

describe('encodeGrant', () => {
  it('given the same grant with keys in another insertion order, should produce identical bytes (rebuilt from the typed value)', () => {
    const grant = makeGrant();
    const reordered = Object.fromEntries(Object.entries(grant).reverse()) as unknown as AgentAccountGrant;
    const actual = Buffer.from(encodeGrant(reordered)).toString('utf8');
    const expected = Buffer.from(encodeGrant(grant)).toString('utf8');
    expect(actual).toBe(expected);
  });

  it('given a grant, should encode every field in the frozen order with no whitespace', () => {
    const keys = JSON.parse(Buffer.from(encodeGrant(makeGrant())).toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(keys)).toEqual(Object.keys(makeGrant()));
  });
});

// ---------------------------------------------------------------------------
// verifyGrant — each deny reason
// ---------------------------------------------------------------------------

describe('verifyGrant deny order (ADR 0004 §6 F1→F17)', () => {
  it('given a well-formed grant signed by the issuer, bound to this run, request, nonce and approval, should return ok with the parsed grant', () => {
    const grant = makeGrant();
    const actual = run(grant);
    expect(actual).toEqual({ ok: true, grant });
  });

  it('given a grant signed with the env-bridge key, should return bad_signature [0004 §8.4]', () => {
    const grant = makeGrant();
    const actual = run(grant, { signature: signWith(envBridge.privateKey, grant) });
    expect(actual).toEqual(deny('bad_signature'));
  });

  it('given an undecodable signature, should return bad_signature', () => {
    const actual = run(makeGrant(), { signature: 'not base64!' });
    expect(actual).toEqual(deny('bad_signature'));
  });

  it('given a verify primitive that throws, should return bad_signature (fail closed)', () => {
    const actual = run(makeGrant(), {
      verify: () => {
        throw new Error('boom');
      },
    });
    expect(actual).toEqual(deny('bad_signature'));
  });

  it.each<keyof AgentAccountGrant>(['grantId', 'nonce', 'bindingDigest', 'exp', 'credentialVersion'])(
    'given field %s altered after signing, should return bad_signature (the signature covers every field)',
    (field) => {
      const original = makeGrant();
      const signature = signWith(issuer.privateKey, original);
      const altered: Record<string, unknown> = { ...original };
      const value = original[field];
      altered[field] = typeof value === 'number' ? value + 1 : `${String(value)}x`;
      const expected = expectedFor(altered as AgentAccountGrant);
      const actual = verifyGrant({
        grant: altered,
        signature,
        issuerPublicKey,
        now: NOW,
        expected,
        requestDigest: REQUEST_DIGEST,
        requestOperation: OPERATION,
        nonceState: 'fresh',
        approval: approvalFor(altered as AgentAccountGrant),
        verify,
        hash,
      });
      expect(actual).toEqual(deny('bad_signature'));
    },
  );

  it('given aud of another channel, should return wrong_audience before the signature is checked [0004 §8.4]', () => {
    const spy = vi.fn<Ed25519Verify>(() => true);
    const actual = run(makeGrant(), { expected: { aud: 'browser-worker', presenter: { keyId: 'pk_exec_1' as PresenterKeyId, channel: 'browser-worker' } }, verify: spy });
    expect({ actual, verifyCalls: spy.mock.calls.length }).toEqual({ actual: deny('wrong_audience'), verifyCalls: 0 });
  });

  it('given presenter.channel !== aud, should return wrong_audience [0004 F2]', () => {
    const grant = makeGrant({ presenter: { keyId: 'pk_exec_1' as PresenterKeyId, channel: 'relay-runner' } });
    const actual = run(grant, { expected: { presenter: grant.presenter } });
    expect(actual).toEqual(deny('wrong_audience'));
  });

  it('given a presenter key other than the executor own key, should return wrong_audience (presenter binding)', () => {
    const actual = run(makeGrant(), { expected: { presenter: { keyId: 'pk_other' as PresenterKeyId, channel: 'http-executor' } } });
    expect(actual).toEqual(deny('wrong_audience'));
  });

  it('given callerCeiling.allowedDriveIds=[d1] and an account in drive d2, should return ceiling before any account fact is consulted [0004 §8.5]', () => {
    const grant = makeGrant({ callerCeiling: { allowedDriveIds: ['drive_other'], originatingMcpTokenId: 'mcp_1' } });
    // Every account fact is deliberately WRONG here: the ceiling is asked first.
    const actual = run(grant, {
      expected: { tenantId: 'user:other' as TenantId, currentCredentialVersion: 99 as CredentialVersion, delegation: { kind: 'none' } },
    });
    expect(actual).toEqual(deny('ceiling'));
  });

  it('given the adapter reports the ceiling does not admit the account, should return ceiling even when the grant lists the drive', () => {
    const actual = run(makeGrant({ callerCeiling: { allowedDriveIds: [DRIVE], originatingMcpTokenId: 'mcp_1' } }), { expected: { ceilingAdmitsAccount: false } });
    expect(actual).toEqual(deny('ceiling'));
  });

  it('given callerCeiling.allowedDriveIds=[], should admit every drive [0004 §8.5]', () => {
    const grant = makeGrant({ callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null } });
    const actual = run(grant, { expected: { accountDriveId: 'drive_anything' as DriveId } });
    expect(actual).toEqual({ ok: true, grant });
  });

  it('given a scoped ceiling and a global-assistant account with no drive, should return ceiling (a scoped credential never gets the benefit of a null drive)', () => {
    const actual = run(makeGrant({ callerCeiling: { allowedDriveIds: [DRIVE], originatingMcpTokenId: 'mcp_1' } }), { expected: { accountDriveId: null, ceilingAdmitsAccount: false } });
    expect(actual).toEqual(deny('ceiling'));
  });

  it('given tenantId differing from the account row, should return tenant_mismatch [0004 F4]', () => {
    const actual = run(makeGrant(), { expected: { tenantId: 'drive:drive_9' as TenantId } });
    expect(actual).toEqual(deny('tenant_mismatch'));
  });

  it('given a valid unused grant whose agentPageId differs from the presenter current run, should return principal_mismatch before any version or delegation fact [0004 §8.20; PR #2637 P1]', () => {
    const actual = run(makeGrant(), {
      expected: { agentPageId: 'page_agent_B' as AgentPageId, currentCredentialVersion: 99 as CredentialVersion, delegation: { kind: 'none' } },
    });
    expect(actual).toEqual(deny('principal_mismatch'));
  });

  it('given a grant whose conversationId or runId differs from the presenter current run, should return principal_mismatch [0004 §8.20]', () => {
    const actual = [
      run(makeGrant(), { expected: { conversationId: 'conv_2' as ConversationId } }),
      run(makeGrant(), { expected: { runId: 'run_2' as RunId } }),
    ];
    expect(actual).toEqual([deny('principal_mismatch'), deny('principal_mismatch')]);
  });

  it('given a grant whose human.userId differs from the acting human of the run, should return principal_mismatch [0004 §8.20]', () => {
    const actual = run(makeGrant(), { expected: { human: { userId: 'user_2' as UserId, sessionId: 'session_1' as SessionId } } });
    expect(actual).toEqual(deny('principal_mismatch'));
  });

  it('given a grant whose human.sessionId differs from the run session, should return principal_mismatch', () => {
    const actual = run(makeGrant(), { expected: { human: { userId: 'user_1' as UserId, sessionId: 'session_2' as SessionId } } });
    expect(actual).toEqual(deny('principal_mismatch'));
  });

  it('given a global-assistant grant (agentPageId null) presented on a run with an agent page, should return principal_mismatch', () => {
    const actual = run(makeGrant({ agentPageId: null }), { expected: { agentPageId: 'page_agent_1' as AgentPageId } });
    expect(actual).toEqual(deny('principal_mismatch'));
  });

  it('given ExpectedBinding, should carry the CURRENT human/agentPageId/conversationId/runId from the presenter context, never from the grant (type-level) [0004 §2.1]', () => {
    const required: Record<'human' | 'agentPageId' | 'conversationId' | 'runId', true> = { human: true, agentPageId: true, conversationId: true, runId: true };
    const keys = Object.keys(expectedFor(makeGrant())) as (keyof ExpectedBinding)[];
    const actual = (Object.keys(required) as (keyof ExpectedBinding)[]).every((key) => keys.includes(key));
    expect(actual).toBe(true);
  });

  it('given credentialVersion one behind current, should return version_mismatch [0004 §8.6]', () => {
    const grant = makeGrant();
    const actual = run(grant, { expected: { currentCredentialVersion: (grant.credentialVersion + 1) as CredentialVersion } });
    expect(actual).toEqual(deny('version_mismatch'));
  });

  it('given accountId or accountKind differing from the row (unknown/revoked collapse), should return version_mismatch [0004 F5]', () => {
    const actual = [
      run(makeGrant(), { expected: { accountId: 'acct_other' as AccountId } }),
      run(makeGrant(), { expected: { accountKind: 'bearer' } }),
    ];
    expect(actual).toEqual([deny('version_mismatch'), deny('version_mismatch')]);
  });

  it('given policyVersion one behind current, should return policy_epoch [0004 §8.6]', () => {
    const grant = makeGrant();
    const actual = run(grant, { expected: { currentPolicyVersion: (grant.policyVersion + 1) as PolicyVersion } });
    expect(actual).toEqual(deny('policy_epoch'));
  });

  it('given human.sessionId null and delegationId null, should return no_delegation [0004 §8.7]', () => {
    const grant = makeGrant({ human: { userId: 'user_1' as UserId, sessionId: null }, delegationId: null });
    const actual = run(grant, { expected: { human: grant.human, delegation: { kind: 'none' } } });
    expect(actual).toEqual(deny('no_delegation'));
  });

  it.each([
    ['expired', { expired: true, revoked: false }],
    ['revoked', { expired: false, revoked: true }],
  ] as const)('given an %s delegation fact, should return no_delegation [0004 §8.7]', (_label, state) => {
    const grant = makeGrant({ human: { userId: 'user_1' as UserId, sessionId: null }, delegationId: 'dlg_1' as DelegationId });
    const actual = run(grant, {
      expected: { human: grant.human, delegation: { kind: 'delegation', delegationId: 'dlg_1' as DelegationId, accountId: grant.accountId, agentPageId: grant.agentPageId, delegatedBy: grant.human.userId, ...state } },
    });
    expect(actual).toEqual(deny('no_delegation'));
  });

  it('given a delegation fact for another account or another delegation id, should return no_delegation', () => {
    const grant = makeGrant({ human: { userId: 'user_1' as UserId, sessionId: null }, delegationId: 'dlg_1' as DelegationId });
    const actual = [
      run(grant, { expected: { human: grant.human, delegation: { kind: 'delegation', delegationId: 'dlg_1' as DelegationId, accountId: 'acct_other' as AccountId, agentPageId: grant.agentPageId, delegatedBy: grant.human.userId, expired: false, revoked: false } } }),
      run(grant, { expected: { human: grant.human, delegation: { kind: 'delegation', delegationId: 'dlg_2' as DelegationId, accountId: grant.accountId, agentPageId: grant.agentPageId, delegatedBy: grant.human.userId, expired: false, revoked: false } } }),
      run(grant, { expected: { human: grant.human, delegation: { kind: 'none' } } }),
    ];
    expect(actual).toEqual([deny('no_delegation'), deny('no_delegation'), deny('no_delegation')]);
  });

  it.each(['needs_reauth', 'revoked', 'deleted'] as const)(
    'given expected.accountStatus %s and an otherwise valid grant, should return account_not_active before version_mismatch — whether credentialVersion is current or stale [0004 §8.28]',
    (accountStatus) => {
      const grant = makeGrant();
      const actual = [
        run(grant, { expected: { accountStatus } }),
        run(grant, { expected: { accountStatus, currentCredentialVersion: (grant.credentialVersion + 1) as CredentialVersion } }),
      ];
      expect(actual).toEqual([deny('account_not_active'), deny('account_not_active')]);
    },
  );

  it('given expected.accountStatus active, should pass the status check [0004 §8.28]', () => {
    const grant = makeGrant();
    const actual = run(grant, { expected: { accountStatus: 'active' } });
    expect(actual).toEqual({ ok: true, grant });
  });

  it('given a live delegation fact for this account whose agentPageId names another agent page, or whose delegatedBy is another user, should return no_delegation [0004 §8.27]', () => {
    const grant = makeGrant({ human: { userId: 'user_1' as UserId, sessionId: null }, delegationId: 'dlg_1' as DelegationId });
    const live = { kind: 'delegation', delegationId: 'dlg_1' as DelegationId, accountId: grant.accountId, agentPageId: grant.agentPageId, delegatedBy: grant.human.userId, expired: false, revoked: false } as const;
    const actual = [
      run(grant, { expected: { human: grant.human, delegation: { ...live, agentPageId: 'page_agent_other' as AgentPageId } } }),
      run(grant, { expected: { human: grant.human, delegation: { ...live, agentPageId: null } } }),
      run(grant, { expected: { human: grant.human, delegation: { ...live, delegatedBy: 'user_other' as UserId } } }),
      run(grant, { expected: { human: grant.human, delegation: live } }),
    ];
    expect(actual).toEqual([deny('no_delegation'), deny('no_delegation'), deny('no_delegation'), { ok: true, grant }]);
  });

  it('given a live delegation for an unattended run, should verify ok', () => {
    const grant = makeGrant({ human: { userId: 'user_1' as UserId, sessionId: null }, delegationId: 'dlg_1' as DelegationId });
    const actual = run(grant, { expected: { human: grant.human } });
    expect(actual).toEqual({ ok: true, grant });
  });

  it('given a live session but the adapter reports no live-session authority, should return no_delegation', () => {
    const actual = run(makeGrant(), { expected: { delegation: { kind: 'none' } } });
    expect(actual).toEqual(deny('no_delegation'));
  });

  it('given a request body differing by one byte from the digested one, should return digest_mismatch [0004 §8.8]', () => {
    const body = new TextEncoder().encode('{"title":"hellp"}');
    const actual = run(makeGrant(), { requestDigest: digestOf({ ...REQUEST_INPUT, body }) });
    expect(actual).toEqual(deny('digest_mismatch'));
  });

  it('given headers reordered, host uppercased, or :443 omitted, should verify ok (digest identical) [0004 §8.8]', () => {
    const grant = makeGrant();
    const variant = digestOf({ ...REQUEST_INPUT, url: 'https://API.GITHUB.COM:443/repos/octo/hello/issues', headers: { Accept: 'application/json' } });
    const actual = run(grant, { requestDigest: variant });
    expect(actual).toEqual({ ok: true, grant });
  });

  it('given operation differing from the presented request operation, should return digest_mismatch [0004 F8]', () => {
    const actual = [
      run(makeGrant(), { requestOperation: { class: 'write', name: 'github.issues.update' } }),
      run(makeGrant(), { requestOperation: { class: 'read', name: 'github.issues.create' } }),
    ];
    expect(actual).toEqual([deny('digest_mismatch'), deny('digest_mismatch')]);
  });

  it('given an attacker who rewrites grant.requestDigest to match their own request, should return bad_signature (the signature covers the digest)', () => {
    const original = makeGrant();
    const signature = signWith(issuer.privateKey, original);
    const evil = digestOf({ ...REQUEST_INPUT, url: 'https://api.github.com/repos/octo/hello/hooks', operation: OPERATION });
    const actual = run({ ...original, requestDigest: evil }, { signature, requestDigest: evil });
    expect(actual).toEqual(deny('bad_signature'));
  });

  it('given sandbox.generation one behind the presenter binding, should return generation_mismatch (restored-sandbox case) [0004 §8.9]', () => {
    const grant = makeGrant({ aud: 'relay-runner' });
    const actual = run(grant, { expected: { sandbox: { spriteName: SANDBOX.spriteName, instanceId: SANDBOX.instanceId, generation: (SANDBOX.generation + 1) as SandboxGeneration } } });
    expect(actual).toEqual(deny('generation_mismatch'));
  });

  it('given a sandbox instance id differing from the presenter binding (recreate), should return generation_mismatch [0006 §8.2]', () => {
    const grant = makeGrant({ aud: 'relay-runner' });
    const actual = run(grant, { expected: { sandbox: { spriteName: SANDBOX.spriteName, instanceId: 'sprite-222' as SandboxInstanceId, generation: SANDBOX.generation } } });
    expect(actual).toEqual(deny('generation_mismatch'));
  });

  it('given a grant naming a sandbox and expected.sandbox null (binding unavailable), should return binding_unavailable, never ok [0006 §8.3; 0004 §8.33]', () => {
    const grant = makeGrant({ aud: 'relay-runner' });
    const actual = run(grant, { expected: { sandbox: null } });
    expect(actual).toEqual(deny('binding_unavailable'));
  });

  it('given grant.sandbox.spriteName differing from expected.sandbox.spriteName with equal instanceId and generation, should return generation_mismatch [0004 §8.33]', () => {
    const grant = makeGrant({ aud: 'relay-runner' });
    const actual = run(grant, { expected: { sandbox: { ...SANDBOX, spriteName: 'ws-other' as SpriteName } } });
    expect(actual).toEqual(deny('generation_mismatch'));
  });

  it('given a relay grant whose sandbox binding matches the presenter view, should verify ok', () => {
    const grant = makeGrant({ aud: 'relay-runner' });
    const actual = run(grant);
    expect(actual).toEqual({ ok: true, grant });
  });

  it('given exp - iat = 15 min + 1 ms, should return ttl_too_long [0004 §8.10]', () => {
    const actual = run(makeGrant({ iat: NOW - 1_000, nbf: NOW - 1_000, exp: NOW - 1_000 + GRANT_LIMITS.maxTtlMs + 1 }));
    expect(actual).toEqual(deny('ttl_too_long'));
  });

  it('given exp - iat = 15 min exactly, should verify ok', () => {
    const grant = makeGrant({ iat: NOW - 1_000, nbf: NOW - 1_000, exp: NOW - 1_000 + GRANT_LIMITS.maxTtlMs });
    const actual = run(grant);
    expect(actual).toEqual({ ok: true, grant });
  });

  it('given iat > now + 30 s, should return clock_skew [0004 F10]', () => {
    const iat = NOW + GRANT_LIMITS.maxClockSkewMs + 1;
    const actual = run(makeGrant({ iat, nbf: iat, exp: iat + 60_000 }));
    expect(actual).toEqual(deny('clock_skew'));
  });

  it('given now < nbf, should return not_yet_valid [0004 §8.10]', () => {
    const iat = NOW + 10_000;
    const actual = run(makeGrant({ iat, nbf: iat, exp: iat + 60_000 }));
    expect(actual).toEqual(deny('not_yet_valid'));
  });

  it('given now > exp, should return expired [0004 F10]', () => {
    const actual = run(makeGrant({ iat: NOW - 60_000, nbf: NOW - 60_000, exp: NOW - 1 }));
    expect(actual).toEqual(deny('expired'));
  });

  it('given nonceState consumed, should return replayed [0004 §8.11]', () => {
    const actual = run(makeGrant(), { nonceState: 'consumed' });
    expect(actual).toEqual(deny('replayed'));
  });

  it('given nonceState unknown, should return replay_store_unavailable, never assume fresh [0004 §8.11]', () => {
    const actual = run(makeGrant(), { nonceState: 'unknown' });
    expect(actual).toEqual(deny('replay_store_unavailable'));
  });

  it('given a concrete approval fact with consumedByGrantId null, should return approval_mismatch [0004 §8.21; PR #2637 P1]', () => {
    const grant = makeGrant();
    const actual = run(grant, { approval: concreteFact({ approvalId: grant.approvalId as ApprovalId, requestDigest: REQUEST_DIGEST, consumedByGrantId: null }) });
    expect(actual).toEqual(deny('approval_mismatch'));
  });

  it('given a concrete approval fact consumed by another grantId, should return approval_mismatch [0004 §8.21]', () => {
    const grant = makeGrant();
    const actual = run(grant, {
      approval: concreteFact({ approvalId: grant.approvalId as ApprovalId, requestDigest: REQUEST_DIGEST, consumedByGrantId: 'grant_other' as GrantId }),
    });
    expect(actual).toEqual(deny('approval_mismatch'));
  });

  it('given a concrete approval fact whose consumedByGrantId equals this grantId, should verify ok [0004 §8.21]', () => {
    const grant = makeGrant();
    const actual = run(grant, { approval: concreteFact({ approvalId: grant.approvalId as ApprovalId, requestDigest: REQUEST_DIGEST, consumedByGrantId: grant.grantId }) });
    expect(actual).toEqual({ ok: true, grant });
  });

  it('given a concrete approval fact consumed by this grant for this digest but recorded for another account, should return approval_mismatch [0004 §8.31]', () => {
    const grant = makeGrant();
    const actual = run(grant, { approval: concreteFact({ accountId: 'acct_other' as AccountId }) });
    expect(actual).toEqual(deny('approval_mismatch'));
  });

  it('given a concrete approval fact whose expiresAt is one ms before grant.iat, should return approval_mismatch; at exactly iat, should pass the approval check [0004 §8.31]', () => {
    const grant = makeGrant();
    const actual = [run(grant, { approval: concreteFact({ expiresAt: grant.iat - 1 }) }), run(grant, { approval: concreteFact({ expiresAt: grant.iat }) })];
    expect(actual).toEqual([deny('approval_mismatch'), { ok: true, grant }]);
  });

  it('given approvalId naming an approval bound to a different digest, should return approval_mismatch [0004 F14]', () => {
    const grant = makeGrant();
    const other = digestOf({ ...REQUEST_INPUT, url: 'https://api.github.com/repos/octo/hello/hooks' });
    const actual = run(grant, { approval: concreteFact({ approvalId: grant.approvalId as ApprovalId, requestDigest: other, consumedByGrantId: grant.grantId }) });
    expect(actual).toEqual(deny('approval_mismatch'));
  });

  it('given a concrete approval fact whose approvalId differs from the grant, or no approval fact at all, should return approval_mismatch', () => {
    const grant = makeGrant();
    const actual = [
      run(grant, { approval: concreteFact({ approvalId: 'approval_other' as ApprovalId, requestDigest: REQUEST_DIGEST, consumedByGrantId: grant.grantId }) }),
      run(grant, { approval: { kind: 'none' } }),
    ];
    expect(actual).toEqual([deny('approval_mismatch'), deny('approval_mismatch')]);
  });

  it('given approvalId policy and a policy fact that is expired or exceeded, should return approval_mismatch [0004 F14]', () => {
    const grant = makeGrant({ approvalId: 'policy', operation: { class: 'read', name: 'github.issues.list' } });
    const actual = [
      run(grant, { requestOperation: grant.operation, approval: { kind: 'policy', policyVersion: grant.policyVersion, expired: true, limitsExceeded: false } }),
      run(grant, { requestOperation: grant.operation, approval: { kind: 'policy', policyVersion: grant.policyVersion, expired: false, limitsExceeded: true } }),
      run(grant, { requestOperation: grant.operation, approval: { kind: 'policy', policyVersion: (grant.policyVersion + 1) as PolicyVersion, expired: false, limitsExceeded: false } }),
      run(grant, { requestOperation: grant.operation, approval: concreteFact({ approvalId: 'approval_1' as ApprovalId, requestDigest: REQUEST_DIGEST, consumedByGrantId: grant.grantId }) }),
    ];
    expect(actual).toEqual([deny('approval_mismatch'), deny('approval_mismatch'), deny('approval_mismatch'), deny('approval_mismatch')]);
  });

  it('given approvalId policy under a live bounded policy for a write, should verify ok', () => {
    const grant = makeGrant({ approvalId: 'policy' });
    const actual = run(grant);
    expect(actual).toEqual({ ok: true, grant });
  });

  it.each(['irreversible', 'privilege'] as const)('given operation class %s with approvalId policy, should return approval_mismatch [0004 §8.12]', (operationClass) => {
    const operation: OperationRef = { class: operationClass, name: 'github.pr.merge' };
    const grant = makeGrant({ approvalId: 'policy', operation });
    const actual = run(grant, { requestOperation: operation });
    expect(actual).toEqual(deny('approval_mismatch'));
  });

  it.each(['http-executor', 'relay-runner', 'refresh-worker'] as const)('given kind password with aud %s, should return kind_not_resolvable [0004 F17]', (aud) => {
    const grant = makeGrant({ aud, accountKind: 'password', presenter: { keyId: 'pk' as PresenterKeyId, channel: aud } });
    const actual = run(grant);
    expect(actual).toEqual(deny('kind_not_resolvable'));
  });

  it('given kind password with aud browser-worker, should verify ok', () => {
    const grant = makeGrant({ aud: 'browser-worker', accountKind: 'password', presenter: { keyId: 'pk' as PresenterKeyId, channel: 'browser-worker' } });
    const actual = run(grant);
    expect(actual).toEqual({ ok: true, grant });
  });

  it('given kind session with aud http-executor and sessionHttp false, should return kind_not_resolvable [0004 §8.23; PR #2637 P1]', () => {
    const actual = run(makeGrant({ accountKind: 'session', sessionHttp: false }));
    expect(actual).toEqual(deny('kind_not_resolvable'));
  });

  it('given kind session with aud http-executor and sessionHttp true, should verify ok (the one audited path)', () => {
    const grant = makeGrant({ accountKind: 'session', sessionHttp: true });
    const actual = run(grant);
    expect(actual).toEqual({ ok: true, grant });
  });

  it.each([
    ['session', 'relay-runner'],
    ['api_key', 'browser-worker'],
    ['api_key', 'refresh-worker'],
    ['session', 'refresh-worker'],
  ] as const)('given kind %s with aud %s (outside ResolvableBy), should return kind_not_resolvable', (accountKind, aud) => {
    const grant = makeGrant({ aud, accountKind, presenter: { keyId: 'pk' as PresenterKeyId, channel: aud } });
    const actual = run(grant);
    expect(actual).toEqual(deny('kind_not_resolvable'));
  });

  it('given a deny toward an untrusted caller, should collapse to one constant-shape refusal with the reason in audit only [0004 F16]', () => {
    const reasons: GrantDenyReason[] = ['malformed', 'bad_signature', 'replayed', 'approval_mismatch', 'kind_not_resolvable'];
    const actual = reasons.map((reason) => collapseVerdictForCaller({ verdict: deny(reason) }));
    expect(actual).toEqual(reasons.map(() => ({ ok: false, error: 'refused' })));
    const grant = makeGrant();
    expect(collapseVerdictForCaller({ verdict: { ok: true, grant } })).toEqual({ ok: true, grantId: grant.grantId });
  });
});

// ---------------------------------------------------------------------------
// Pairwise two-fault table (§8.10): the EARLIER reason in F1→F17 wins.
// ---------------------------------------------------------------------------

type Scenario = { grant: Record<string, unknown>; opts: RunOpts; key: typeof issuer.privateKey };
type Fault = { readonly reason: GrantDenyReason; readonly row: string; readonly apply: (s: Scenario) => Scenario };

const OTHER_DIGEST = digestOf({ ...REQUEST_INPUT, url: 'https://api.github.com/repos/octo/hello/hooks' });

const FAULTS: readonly Fault[] = [
  { reason: 'malformed', row: 'F1', apply: (s) => ({ ...s, grant: { ...s.grant, grantId: undefined } }) },
  { reason: 'wrong_audience', row: 'F2', apply: (s) => ({ ...s, opts: { ...s.opts, expected: { ...s.opts.expected, aud: 'http-executor', presenter: { keyId: 'pk_relay' as PresenterKeyId, channel: 'http-executor' } } } }) },
  { reason: 'ceiling', row: 'F3', apply: (s) => ({ ...s, opts: { ...s.opts, expected: { ...s.opts.expected, ceilingAdmitsAccount: false } } }) },
  { reason: 'tenant_mismatch', row: 'F4', apply: (s) => ({ ...s, opts: { ...s.opts, expected: { ...s.opts.expected, tenantId: 'user:other' as TenantId } } }) },
  { reason: 'principal_mismatch', row: 'F4a', apply: (s) => ({ ...s, opts: { ...s.opts, expected: { ...s.opts.expected, runId: 'run_other' as RunId } } }) },
  { reason: 'account_not_active', row: 'F5', apply: (s) => ({ ...s, opts: { ...s.opts, expected: { ...s.opts.expected, accountStatus: 'revoked' } } }) },
  { reason: 'version_mismatch', row: 'F5a', apply: (s) => ({ ...s, opts: { ...s.opts, expected: { ...s.opts.expected, currentCredentialVersion: 99 as CredentialVersion } } }) },
  { reason: 'policy_epoch', row: 'F6', apply: (s) => ({ ...s, opts: { ...s.opts, expected: { ...s.opts.expected, currentPolicyVersion: 99 as PolicyVersion } } }) },
  { reason: 'no_delegation', row: 'F7', apply: (s) => ({ ...s, opts: { ...s.opts, expected: { ...s.opts.expected, delegation: { kind: 'none' } } } }) },
  { reason: 'digest_mismatch', row: 'F8', apply: (s) => ({ ...s, opts: { ...s.opts, requestDigest: OTHER_DIGEST } }) },
  { reason: 'generation_mismatch', row: 'F9', apply: (s) => ({ ...s, opts: { ...s.opts, expected: { ...s.opts.expected, sandbox: { spriteName: SANDBOX.spriteName, instanceId: SANDBOX.instanceId, generation: 99 as SandboxGeneration } } } }) },
  { reason: 'binding_unavailable', row: 'F9', apply: (s) => ({ ...s, opts: { ...s.opts, expected: { ...s.opts.expected, sandbox: null } } }) },
  { reason: 'ttl_too_long', row: 'F10', apply: (s) => ({ ...s, grant: { ...s.grant, iat: NOW - 1_000, nbf: NOW - 1_000, exp: NOW - 1_000 + GRANT_LIMITS.maxTtlMs + 1 } }) },
  { reason: 'clock_skew', row: 'F10', apply: (s) => ({ ...s, grant: { ...s.grant, iat: NOW + 40_000, nbf: NOW + 40_000, exp: NOW + 100_000 } }) },
  { reason: 'not_yet_valid', row: 'F10', apply: (s) => ({ ...s, grant: { ...s.grant, iat: NOW + 10_000, nbf: NOW + 10_000, exp: NOW + 70_000 } }) },
  { reason: 'expired', row: 'F10', apply: (s) => ({ ...s, grant: { ...s.grant, iat: NOW - 60_000, nbf: NOW - 60_000, exp: NOW - 1 } }) },
  { reason: 'bad_signature', row: 'F11', apply: (s) => ({ ...s, key: envBridge.privateKey }) },
  { reason: 'replayed', row: 'F12', apply: (s) => ({ ...s, opts: { ...s.opts, nonceState: 'consumed' } }) },
  { reason: 'replay_store_unavailable', row: 'F12', apply: (s) => ({ ...s, opts: { ...s.opts, nonceState: 'unknown' } }) },
  {
    reason: 'approval_mismatch',
    row: 'F14',
    apply: (s) => ({ ...s, opts: { ...s.opts, approval: concreteFact({ approvalId: 'approval_1' as ApprovalId, requestDigest: REQUEST_DIGEST, consumedByGrantId: null }) } }),
  },
  { reason: 'kind_not_resolvable', row: 'F17', apply: (s) => ({ ...s, grant: { ...s.grant, accountKind: 'password' }, opts: { ...s.opts, expected: { ...s.opts.expected, accountKind: 'password' } } }) },
];

function runScenario(s: Scenario) {
  const grant = s.grant as unknown as AgentAccountGrant;
  return run(s.grant, { ...s.opts, signature: signWith(s.key, grant) });
}

describe('verifyGrant two-fault table (ADR 0004 §8.10)', () => {
  const base = (): Scenario => ({ grant: { ...makeGrant({ aud: 'relay-runner', presenter: { keyId: 'pk_relay' as PresenterKeyId, channel: 'relay-runner' } }) }, opts: {}, key: issuer.privateKey });

  it.each(FAULTS.map((fault) => [fault.reason, fault] as const))('given the single fault %s, should return exactly that reason', (_reason, fault) => {
    const actual = runScenario(fault.apply(base()));
    expect(actual).toEqual(deny(fault.reason));
  });

  const pairs: (readonly [Fault, Fault])[] = [];
  for (let i = 0; i < FAULTS.length; i += 1) {
    for (let j = i + 1; j < FAULTS.length; j += 1) {
      if (FAULTS[i]!.row !== FAULTS[j]!.row) pairs.push([FAULTS[i]!, FAULTS[j]!] as const);
    }
  }

  it.each(pairs.map(([a, b]) => [a.reason, b.reason, a, b] as const))('given faults %s + %s, should return the earlier reason in the fixed order F1→F17', (_a, _b, earlier, later) => {
    const actual = runScenario(later.apply(earlier.apply(base())));
    expect(actual).toEqual(deny(earlier.reason));
  });

  it('given the base scenario with no fault, should verify ok', () => {
    const s = base();
    const actual = runScenario(s);
    expect(actual).toEqual({ ok: true, grant: s.grant });
  });
});

// ---------------------------------------------------------------------------
// decideSandboxBinding (ADR 0006 §7, §8.1–3)
// ---------------------------------------------------------------------------

describe('decideSandboxBinding (ADR 0006 §8.1–3)', () => {
  const observed = SANDBOX;

  it('given aud relay-runner and grant null, should return malformed [0006 §8.1]', () => {
    const actual = decideSandboxBinding({ grant: null, observed, aud: 'relay-runner' });
    expect(actual).toEqual({ ok: false, reason: 'malformed' });
  });

  it('given sandbox set and aud http-executor, should return malformed [0006 §8.1]', () => {
    const actual = decideSandboxBinding({ grant: SANDBOX, observed, aud: 'http-executor' });
    expect(actual).toEqual({ ok: false, reason: 'malformed' });
  });

  it('given an observed instanceId that differs from the grant, should return generation_mismatch [0006 §8.2]', () => {
    const actual = decideSandboxBinding({ grant: SANDBOX, observed: { ...observed, instanceId: 'sprite-222' as SandboxInstanceId }, aud: 'relay-runner' });
    expect(actual).toEqual({ ok: false, reason: 'generation_mismatch' });
  });

  it('given the same instanceId but generation + 1 (restore), should return generation_mismatch [0006 §8.2]', () => {
    const actual = decideSandboxBinding({ grant: SANDBOX, observed: { ...observed, generation: (SANDBOX.generation + 1) as SandboxGeneration }, aud: 'relay-runner' });
    expect(actual).toEqual({ ok: false, reason: 'generation_mismatch' });
  });

  it('given observed null (store/API unreachable), should return binding_unavailable, never ok [0006 §8.3]', () => {
    const actual = decideSandboxBinding({ grant: SANDBOX, observed: null, aud: 'relay-runner' });
    expect(actual).toEqual({ ok: false, reason: 'binding_unavailable' });
  });

  it('given a matching binding, should return ok; given no sandbox on a non-relay channel, should return ok', () => {
    const actual = [decideSandboxBinding({ grant: SANDBOX, observed, aud: 'relay-runner' }), decideSandboxBinding({ grant: null, observed: null, aud: 'http-executor' })];
    expect(actual).toEqual([{ ok: true }, { ok: true }]);
  });
});

// ---------------------------------------------------------------------------
// Input-type hygiene (ADR 0006 §8.4)
// ---------------------------------------------------------------------------

describe('verifyGrant input type (ADR 0006 §8.4)', () => {
  it('given VerifyGrantInput, should have no key matching /header|ip|forwarded|sprite/i except sandbox (type-level test)', () => {
    // Exhaustive by construction: a key added to VerifyGrantInput or ExpectedBinding fails typecheck here.
    const inputKeys: Record<keyof VerifyGrantInput, true> = {
      grant: true,
      signature: true,
      issuerPublicKey: true,
      now: true,
      expected: true,
      requestDigest: true,
      requestOperation: true,
      nonceState: true,
      approval: true,
      verify: true,
      hash: true,
    };
    const expectedKeys: Record<keyof ExpectedBinding, true> = {
      aud: true,
      presenter: true,
      human: true,
      agentPageId: true,
      conversationId: true,
      runId: true,
      tenantId: true,
      accountId: true,
      accountKind: true,
      accountStatus: true,
      accountDriveId: true,
      currentCredentialVersion: true,
      currentPolicyVersion: true,
      delegation: true,
      sandbox: true,
      ceilingAdmitsAccount: true,
    };
    const keys = [...Object.keys(inputKeys), ...Object.keys(expectedKeys)];
    const actual = keys.filter((key) => key !== 'sandbox' && /header|ip|forwarded|sprite/i.test(key));
    expect(actual).toEqual([]);
  });
});

describe('nonce recorded only on ok — adapter (ADR 0004 §8.11)', () => {
  it.todo('given a grant failing bad_signature, should leave the replay store untouched — see grant-gate-executor.integration.test.ts');
  it.todo('given a grant verifying ok, should record the nonce exactly once — see grant-gate-executor.integration.test.ts');
});

describe('mutation pairs (Control Board §7.4; ADR 0004 §8.19)', () => {
  it.todo('given the digest compare broken by line index, should go RED on §8.8; restored, GREEN — evidence in the channel and PR body');
  it.todo('given the nonce-only-on-ok rule broken, should go RED on §8.11; restored, GREEN — evidence in the channel and PR body');
  it.todo('given the ceiling-first rule broken, should go RED on §8.5; restored, GREEN — evidence in the channel and PR body');
  it.todo('given the aud check broken, should go RED on §8.4; restored, GREEN — evidence in the channel and PR body');
});

// Keep the AccountKind import live for the fixtures' narrowing.
const _kinds: readonly AccountKind[] = ['api_key', 'bearer', 'oauth2', 'session', 'password'];
void _kinds;
