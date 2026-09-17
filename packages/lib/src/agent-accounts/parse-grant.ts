/**
 * `parseGrant` — schema and structural sanity only (ADR 0004 F1).
 *
 * `.strict()` everywhere: an extra field is not "ignored", it is a malformed
 * grant — a privileged-looking `isAdmin: true` riding along must fail
 * closed. Every field is required; `null` is legal only where `grant.ts`
 * says so; `undefined` and missing keys are malformed. The window's sanity
 * is structure, not policy: `exp < iat` is not a short grant, it is not a
 * grant (env-bridge precedent, Codex C15), and `nbf > iat` likewise. The
 * relay/sandbox pairing (ADR 0006 F1) and the `sessionHttp` flag's
 * confinement to `session` × `http-executor` are structural too.
 *
 * The typed grant is REBUILT field by field from the parsed data — brands
 * are applied here, once — so nothing but the frozen shape leaves this
 * function. Pure.
 */
import { z } from 'zod';
import type {
  AgentAccountGrant,
  AgentPageId,
  ApprovalId,
  BindingDigest,
  ConversationId,
  DelegationId,
  GrantId,
  Nonce,
  ParseGrant,
  PresenterKeyId,
  RequestDigest,
  RunId,
  SandboxGeneration,
  SandboxInstanceId,
  SessionId,
  SpriteName,
  UserId,
} from './grant';
import type { AccountId, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import { GRANT_ISSUER } from './grant-constants';
import { decideSandboxBinding } from './decide-sandbox-binding';

const PRESENTER_CHANNELS = ['http-executor', 'relay-runner', 'browser-worker', 'refresh-worker'] as const;
const ACCOUNT_KINDS = ['api_key', 'bearer', 'oauth2', 'session', 'password'] as const;
const OPERATION_CLASSES = ['read', 'write', 'irreversible', 'privilege', 'unknown'] as const;

const id = z.string().min(1);
const ms = z.number().int().nonnegative();
const version = z.number().int().nonnegative();

const grantSchema = z
  .object({
    grantId: id,
    iss: z.literal(GRANT_ISSUER),
    aud: z.enum(PRESENTER_CHANNELS),
    tenantId: id,
    human: z.object({ userId: id, sessionId: id.nullable() }).strict(),
    delegationId: id.nullable(),
    agentPageId: id.nullable(),
    conversationId: id,
    runId: id,
    sandbox: z.object({ spriteName: id, instanceId: id, generation: z.number().int().nonnegative() }).strict().nullable(),
    callerCeiling: z.object({ allowedDriveIds: z.array(id), originatingMcpTokenId: id.nullable() }).strict(),
    accountId: id,
    accountKind: z.enum(ACCOUNT_KINDS),
    credentialVersion: version,
    policyVersion: version,
    bindingDigest: id,
    operation: z.object({ class: z.enum(OPERATION_CLASSES), name: id }).strict(),
    requestDigest: id,
    sessionHttp: z.boolean(),
    approvalId: id,
    iat: ms,
    nbf: ms,
    exp: ms,
    nonce: id,
    presenter: z.object({ keyId: id, channel: z.enum(PRESENTER_CHANNELS) }).strict(),
  })
  .strict();

const MALFORMED = { ok: false, reason: 'malformed' } as const;

export const parseGrant: ParseGrant = ({ grant }) => {
  const parsed = grantSchema.safeParse(grant);
  if (!parsed.success) return MALFORMED;
  const d = parsed.data;

  if (d.exp < d.iat) return MALFORMED;
  if (d.nbf > d.iat) return MALFORMED;
  if (d.sessionHttp && !(d.accountKind === 'session' && d.aud === 'http-executor')) return MALFORMED;

  const sandbox =
    d.sandbox === null
      ? null
      : { spriteName: d.sandbox.spriteName as SpriteName, instanceId: d.sandbox.instanceId as SandboxInstanceId, generation: d.sandbox.generation as SandboxGeneration };
  const pairing = decideSandboxBinding({ grant: sandbox, observed: null, aud: d.aud });
  if (!pairing.ok && pairing.reason === 'malformed') return MALFORMED;

  const typed: AgentAccountGrant = {
    grantId: d.grantId as GrantId,
    iss: d.iss,
    aud: d.aud,
    tenantId: d.tenantId as TenantId,
    human: { userId: d.human.userId as UserId, sessionId: d.human.sessionId === null ? null : (d.human.sessionId as SessionId) },
    delegationId: d.delegationId === null ? null : (d.delegationId as DelegationId),
    agentPageId: d.agentPageId === null ? null : (d.agentPageId as AgentPageId),
    conversationId: d.conversationId as ConversationId,
    runId: d.runId as RunId,
    sandbox,
    callerCeiling: { allowedDriveIds: [...d.callerCeiling.allowedDriveIds], originatingMcpTokenId: d.callerCeiling.originatingMcpTokenId },
    accountId: d.accountId as AccountId,
    accountKind: d.accountKind,
    credentialVersion: d.credentialVersion as CredentialVersion,
    policyVersion: d.policyVersion as PolicyVersion,
    bindingDigest: d.bindingDigest as BindingDigest,
    operation: { class: d.operation.class, name: d.operation.name },
    requestDigest: d.requestDigest as RequestDigest,
    sessionHttp: d.sessionHttp,
    approvalId: d.approvalId === 'policy' ? 'policy' : (d.approvalId as ApprovalId),
    iat: d.iat,
    nbf: d.nbf,
    exp: d.exp,
    nonce: d.nonce as Nonce,
    presenter: { keyId: d.presenter.keyId as PresenterKeyId, channel: d.presenter.channel },
  };
  return { ok: true, grant: typed };
};
