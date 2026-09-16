/**
 * `verifyGrant` — the whole intersection (threat model §4: caller ∩
 * delegation ∩ permission ∩ grant ∩ restriction ∩ approval ∩ epoch) as ONE
 * pure function in a FIXED deny order (ADR 0004 §6, F1→F17):
 *
 *   malformed → wrong_audience → ceiling → tenant_mismatch →
 *   principal_mismatch → account_not_active → version_mismatch →
 *   policy_epoch → no_delegation → digest_mismatch →
 *   generation_mismatch / binding_unavailable → ttl_too_long / clock_skew /
 *   not_yet_valid / expired → bad_signature → replayed /
 *   replay_store_unavailable → approval_mismatch → kind_not_resolvable
 *
 * Why this order. Structure first, so junk never reaches crypto. The caller
 * CEILING before any account fact (axiom 8: a drive-scoped credential must
 * read an account outside its drives as nonexistent, whatever the row says).
 * The CURRENT run's principals — from the presenter's own context, never the
 * grant — before versions and delegations, so a valid unused grant for
 * another agent page, thread or run is refused as the wrong grant, not as a
 * stale one (Codex P1 on PR #2637). The request binding (operation + digest)
 * before the signature: a signed grant for other work is still the wrong
 * grant, and the compare is cheap. Replay LAST among the cheap checks so a
 * grant that failed anything above can never burn its nonce — the adapter
 * records the nonce only when this function says `ok` (§8.11).
 *
 * Pure by construction: the clock, the Ed25519 primitive, the hash and every
 * fact the adapter fetched (`expected`, `nonceState`, `approval`) are
 * parameters. Nothing here reads `Date.now()`, touches `node:crypto`, or
 * performs I/O, which is what makes the adversarial tables exhaustive rather
 * than flaky. Digest compares go through `secureCompare` (SHA3-256 then
 * compare — the repo rule), never a raw string compare.
 */
import type { AccountKind } from '@pagespace/db/schema/agent-accounts';
import { isDriveWithinCredentialScope } from '../agent-workspaces/credential-scope';
import { secureCompare } from '../auth/secure-compare';
import type { AgentAccountGrant, ApprovalFact, DelegationFact, ExpectedBinding, GrantDenyReason, GrantVerdict, PresenterChannel, VerifyGrant } from './grant';
import { GRANT_LIMITS } from './grant-constants';
import { parseGrant } from './parse-grant';
import { encodeGrant } from './encode-grant';
import { decodeBase64 } from './decode-base64';
import { decideSandboxBinding } from './decide-sandbox-binding';

const deny = (reason: GrantDenyReason): GrantVerdict => ({ ok: false, reason });

/**
 * Which kinds each channel may resolve (ADR 0005 §4.2, `ResolvableBy`), as
 * a full `Record` so an added kind or channel must be classified here.
 * `session` over `http-executor` is the one gated exception (`sessionHttp`).
 */
const RESOLVABLE: Readonly<Record<PresenterChannel, Readonly<Record<AccountKind, boolean>>>> = {
  'http-executor': { api_key: true, bearer: true, oauth2: true, session: false, password: false },
  'relay-runner': { api_key: true, bearer: true, oauth2: true, session: false, password: false },
  'browser-worker': { api_key: false, bearer: false, oauth2: false, session: true, password: true },
  'refresh-worker': { api_key: false, bearer: false, oauth2: true, session: false, password: false },
};

function kindResolvable(grant: AgentAccountGrant): boolean {
  if (RESOLVABLE[grant.aud][grant.accountKind]) return true;
  return grant.accountKind === 'session' && grant.aud === 'http-executor' && grant.sessionHttp;
}

/**
 * F5a — the current credential version, or the plane-attested PREVIOUS one
 * while a rotation's grace window is open and only for a grant issued before
 * that rotation: a grant in flight across a refresh still resolves, and old
 * material never gets a fresh grant (ADR 0004 F5a; G1a review M7).
 */
function credentialVersionAdmitted(grant: AgentAccountGrant, expected: ExpectedBinding, now: number, rotationGraceMs: number): boolean {
  if (grant.credentialVersion === expected.currentCredentialVersion) return true;
  if (expected.previousCredentialVersion === null || expected.rotatedAt === null) return false;
  return (
    grant.credentialVersion === expected.previousCredentialVersion &&
    grant.iat < expected.rotatedAt &&
    now < expected.rotatedAt + rotationGraceMs
  );
}

function delegationHolds(grant: AgentAccountGrant, fact: DelegationFact): boolean {
  if (grant.delegationId !== null) {
    // Consent from ONE human for ONE account on ONE agent page: all four ids.
    return (
      fact.kind === 'delegation' &&
      fact.delegationId === grant.delegationId &&
      fact.accountId === grant.accountId &&
      fact.agentPageId === grant.agentPageId &&
      fact.delegatedBy === grant.human.userId &&
      !fact.expired &&
      !fact.revoked
    );
  }
  if (grant.human.sessionId === null) return false;
  return fact.kind === 'live_session';
}

function approvalHolds(grant: AgentAccountGrant, fact: ApprovalFact): boolean {
  if (grant.approvalId === 'policy') {
    // F15: always-allow never covers these classes, whatever any row says.
    if (grant.operation.class === 'irreversible' || grant.operation.class === 'privilege') return false;
    return fact.kind === 'policy' && fact.policyVersion === grant.policyVersion && !fact.expired && !fact.limitsExceeded;
  }
  return (
    fact.kind === 'concrete' &&
    fact.approvalId === grant.approvalId &&
    fact.accountId === grant.accountId &&
    // An approval that had expired when the grant was issued never authorized it.
    fact.expiresAt >= grant.iat &&
    secureCompare(fact.requestDigest, grant.requestDigest) &&
    fact.consumedByGrantId === grant.grantId
  );
}

export const verifyGrant: VerifyGrant = (input) => {
  // F1 — structure. Nothing else is evaluated for a malformed grant.
  const parsed = parseGrant({ grant: input.grant });
  if (!parsed.ok) return deny('malformed');
  const grant = parsed.grant;
  const { expected } = input;

  // F2 — issuer/audience/presenter. `iss` is a literal in the schema. Four
  // independent lines so each is load-bearing under mutation: the audience,
  // the grant's own presenter/aud agreement, the executor's key, and the
  // adapter's own consistency (an executor whose expected presenter channel
  // is not its expected audience is misconfigured and must refuse).
  if (grant.aud !== expected.aud) return deny('wrong_audience');
  if (grant.presenter.channel !== grant.aud) return deny('wrong_audience');
  if (grant.presenter.keyId !== expected.presenter.keyId) return deny('wrong_audience');
  if (expected.presenter.channel !== expected.aud) return deny('wrong_audience');

  // F3 — the caller ceiling, asked before any account fact.
  if (!expected.ceilingAdmitsAccount) return deny('ceiling');
  if (!isDriveWithinCredentialScope(grant.callerCeiling.allowedDriveIds, expected.accountDriveId)) return deny('ceiling');

  // F4 — tenant.
  if (grant.tenantId !== expected.tenantId) return deny('tenant_mismatch');

  // F4a — the CURRENT run's principals, from the presenter's own context.
  if (grant.human.userId !== expected.human.userId || grant.human.sessionId !== expected.human.sessionId) return deny('principal_mismatch');
  if (grant.agentPageId !== expected.agentPageId) return deny('principal_mismatch');
  if (grant.conversationId !== expected.conversationId || grant.runId !== expected.runId) return deny('principal_mismatch');

  // F5 — the account is usable at all; the status goes to audit, not the caller.
  if (expected.accountStatus !== 'active') return deny('account_not_active');

  // F5a — the account row and its current credential version.
  if (grant.accountId !== expected.accountId || grant.accountKind !== expected.accountKind) return deny('version_mismatch');
  if (!credentialVersionAdmitted(grant, expected, input.now, input.rotationGraceMs)) return deny('version_mismatch');

  // F6 — policy epoch.
  if (grant.policyVersion !== expected.currentPolicyVersion) return deny('policy_epoch');

  // F7 — delegation for an unattended run, or a live session.
  if (!delegationHolds(grant, expected.delegation)) return deny('no_delegation');

  // F8 — the request binding: operation and digest, constant-time.
  if (grant.operation.class !== input.requestOperation.class || grant.operation.name !== input.requestOperation.name) return deny('digest_mismatch');
  if (!secureCompare(grant.requestDigest, input.requestDigest)) return deny('digest_mismatch');

  // F9 — sandbox name + instance + generation (ADR 0006); unobservable is its own refusal.
  const binding = decideSandboxBinding({ grant: grant.sandbox, observed: expected.sandbox, aud: grant.aud });
  if (!binding.ok) return deny(binding.reason);

  // F10 — the window.
  if (grant.exp - grant.iat > GRANT_LIMITS.maxTtlMs) return deny('ttl_too_long');
  if (grant.iat > input.now + GRANT_LIMITS.maxClockSkewMs) return deny('clock_skew');
  if (input.now < grant.nbf) return deny('not_yet_valid');
  if (input.now > grant.exp) return deny('expired');

  // F11 — the issuer's signature over the canonical bytes.
  const signature = decodeBase64(input.signature);
  if (signature === null) return deny('bad_signature');
  let valid = false;
  try {
    valid = input.verify(encodeGrant(grant), signature, input.issuerPublicKey);
  } catch {
    valid = false;
  }
  if (!valid) return deny('bad_signature');

  // F12 — replay, from the ledger's facts; unknown is never fresh.
  if (input.nonceState === 'consumed') return deny('replayed');
  if (input.nonceState === 'unknown') return deny('replay_store_unavailable');

  // F14/F15 — the approval this grant consumed.
  if (!approvalHolds(grant, input.approval)) return deny('approval_mismatch');

  // F17 — may this channel resolve this kind at all.
  if (!kindResolvable(grant)) return deny('kind_not_resolvable');

  return { ok: true, grant };
};
