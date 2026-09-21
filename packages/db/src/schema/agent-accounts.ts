/**
 * AGENT ACCOUNTS — the reference rows (ADR 0005 §4; Control Board §1
 * "Account reference schema", name fixed here).
 *
 * Frozen at L1·G1a as TYPES ONLY. G2 turns these into `pgTable`s, exports
 * them from `schema.ts`, and generates the migration (`bun run db:generate`);
 * G2 may add columns only via a [D-n]. This file is deliberately NOT exported
 * from `schema.ts` yet: CI runs `db:generate` and a table without its
 * migration would drift.
 *
 * THERE IS NO SECRET COLUMN. Every value that is not display metadata is a
 * version, a policy or an acknowledgment. Material lives in the credential
 * plane (Infisical, D-21) under a per-tenant key (D-17), addressed by
 * `(tenantId, accountId, kind)`. A source-level test (ADR 0005 §10.1) fails
 * on any column name matching /credential|secret|token|password/ other than
 * the `kind` literal.
 *
 * Timestamps are UTC ms in these types; G2 maps them to `timestamp(…, {mode:'date'})`
 * with `(now() at time zone 'utc')` defaults.
 */

// ---------------------------------------------------------------------------
// Canonical unions (one per concept; `Record<Union, V>` for per-variant data)
// ---------------------------------------------------------------------------

/** D-20: passwords + TOTP ARE in v1, external store only. */
export type AccountKind = 'api_key' | 'bearer' | 'oauth2' | 'session' | 'password';

/** D-16: user-owned or agent-page-owned now; drive-shared later (same TenantId space). */
export type AccountOwnerKind = 'user' | 'agent_page';

/**
 * Required on every row. The add-account UI defaults to
 * `dedicated_agent_account` and requires an explicit tick for
 * `personal_login_acknowledged` (Λ3 copy, threat model §9).
 */
export type AccountAcknowledgment = 'dedicated_agent_account' | 'personal_login_acknowledged';

/** `revoked` = broker-denied; `needs_reauth` = upstream expired/invalid; `deleted` = material removed. */
export type AccountStatus = 'active' | 'revoked' | 'needs_reauth' | 'deleted';

/** S3 §5: a cookie jar is not a universal session. Non-null iff `kind = 'session'`. */
export type SessionFormat = 'cookie-jar-v1' | 'storage-state-v1' | 'human-relogin';

/** What happened at the provider when we tried to revoke there (ADR 0005 §2.2 `delete`). */
export type UpstreamRevocation = 'not_attempted' | 'revoked' | 'unsupported' | 'failed';

// ---------------------------------------------------------------------------
// Branded ids and versions owned by this layer
// ---------------------------------------------------------------------------

export type AccountId = string & { readonly __brand: 'AccountId' };
/** Derived, never chosen: `user:<userId>` or `drive:<driveId>` (ADR 0005 §3.1). Immutable. */
export type TenantId = string & { readonly __brand: 'TenantId' };
/** Mirrors the store's current secret version; bumped by put/rotate. */
export type CredentialVersion = number & { readonly __brand: 'CredentialVersion' };
/** Bumped by every authority-relevant change (ADR 0004 §4.4). */
export type PolicyVersion = number & { readonly __brand: 'PolicyVersion' };

/** Exactly one FK set (CHECK in G2, as `integration_connections_scope_chk`). */
export type AccountOwnerRef =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'agent_page'; readonly agentPageId: string; readonly driveId: string };

// ---------------------------------------------------------------------------
// agent_accounts
// ---------------------------------------------------------------------------

export type AgentAccountRow = {
  readonly id: AccountId;
  readonly kind: AccountKind;
  readonly ownerKind: AccountOwnerKind;
  /** FK users.id, cascade; non-null iff ownerKind = 'user'. */
  readonly ownerUserId: string | null;
  /** FK pages.id, cascade; non-null iff ownerKind = 'agent_page'. */
  readonly ownerAgentPageId: string | null;
  /** FK drives.id; non-null iff ownerKind = 'agent_page'. */
  readonly ownerDriveId: string | null;
  readonly tenantId: TenantId;
  readonly name: string;
  /** Selects the operation catalogue; null = generic origin. */
  readonly providerSlug: string | null;
  /** Canonical origins (ADR 0004 §3.2); non-empty. */
  readonly allowedOrigins: readonly string[];
  /** Human-approved at capture (S3 §3.5); may be empty. */
  readonly auxiliaryOrigins: readonly string[];
  /** Per-provider resource allowlists (repo/org/recipient/webhook). Shape owned by the provider catalogue. */
  readonly resourceRestrictions: Readonly<Record<string, readonly string[]>>;
  /** `AccountApprovalPolicy` (lib `agent-accounts/approval.ts`) as stored JSON; null = every use asks. */
  readonly approvalPolicy: unknown | null;
  readonly credentialVersion: CredentialVersion;
  readonly policyVersion: PolicyVersion;
  readonly acknowledgment: AccountAcknowledgment;
  readonly sessionFormat: SessionFormat | null;
  /**
   * Default false. When true (set only through `manage`), the account's
   * `session` material may be resolved by the HTTP executor under the
   * `session_http` permission (ADR 0005 §4.2). Meaningful only for kind
   * `session`; G2 adds a CHECK that it is false for every other kind. Any
   * change bumps `policyVersion` (ADR 0004 §4.4), so turning it off ends
   * outstanding `sessionHttp: true` grants at once (G1a review M4).
   */
  readonly sessionHttpEnabled: boolean;
  readonly status: AccountStatus;
  readonly upstreamRevocation: UpstreamRevocation | null;
  readonly lastUsedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revokedAt: number | null;
};

// ---------------------------------------------------------------------------
// agent_account_bindings — a user-owned account bound to an agent page
// (ADR 0005 §4.3). Does NOT make the account usable by other humans.
// ---------------------------------------------------------------------------

export type AgentAccountBindingRow = {
  readonly accountId: AccountId;
  readonly agentPageId: string;
  readonly boundByUserId: string;
  readonly boundAt: number;
  readonly revokedAt: number | null;
};

// ---------------------------------------------------------------------------
// agent_account_delegations — standing consent for unattended runs
// (ADR 0004 §4.4). Required whenever `human.sessionId` is null.
// ---------------------------------------------------------------------------

export type AgentAccountDelegationRow = {
  readonly id: string;
  readonly accountId: AccountId;
  readonly agentPageId: string | null;
  readonly delegatedByUserId: string;
  /** `ApprovalScope` as stored JSON. */
  readonly scope: unknown;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly revokedAt: number | null;
};

// ---------------------------------------------------------------------------
// agent_account_approvals — a concrete human decision bound to ONE digest,
// consumed exactly once (ADR 0004 §4.3).
// ---------------------------------------------------------------------------

export type AgentAccountApprovalRow = {
  readonly id: string;
  readonly accountId: AccountId;
  readonly requestDigest: string;
  readonly outcome: 'allow_once' | 'always' | 'deny';
  readonly approvedByUserId: string;
  /** The session (or step-up challenge) that carried the decision — never a model turn. */
  readonly approvedViaSessionId: string;
  readonly stepUpChallengeId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Stamped by the ONE consuming grant issuance; a second finds it set and fails. */
  readonly consumedAt: number | null;
  readonly consumedByGrantId: string | null;
};

// ---------------------------------------------------------------------------
// agent_account_grant_nonces — replay ledger, atomic across replicas,
// survives restart (ADR 0004 §2.4). The database is the single-use ledger,
// as `dev_preview_grants` already is.
// ---------------------------------------------------------------------------

export type AgentAccountGrantNonceRow = {
  readonly nonce: string;
  readonly grantId: string;
  readonly expiresAt: number;
  readonly consumedAt: number;
};

// ---------------------------------------------------------------------------
// agent_account_secret_versions is NOT a main-DB table (G1c R3). ADR 0005
// §2.5 first listed it here, but `previousVersion`, `rotatedAt` and
// `revokedAt` are the PLANE-ATTESTED facts the verifier and `decideResolve`
// trust: a main-DB writer who owned those rows could un-revoke a credential or
// reopen a rotation grace. The row, the plane's bindings row and their DDL
// live in the plane's own metadata store
// (`packages/lib/src/agent-accounts/store/infisical-dev/plane-metadata.sql`).
// ---------------------------------------------------------------------------

/** The tables G2 creates, in one place so the migration and the knip entry agree. */
export type AgentAccountsTables = {
  readonly agent_accounts: AgentAccountRow;
  readonly agent_account_bindings: AgentAccountBindingRow;
  readonly agent_account_delegations: AgentAccountDelegationRow;
  readonly agent_account_approvals: AgentAccountApprovalRow;
  readonly agent_account_grant_nonces: AgentAccountGrantNonceRow;
};
