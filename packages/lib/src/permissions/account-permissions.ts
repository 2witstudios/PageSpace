/**
 * ACCOUNT PERMISSION SEMANTICS — view / use / manage / grant (ADR 0004 §4).
 *
 * Frozen at L1·G1a; types only. G1b implements `decideAccountAccess` beside
 * this file and the repository that fetches `AccountAccessFacts`.
 *
 * Why this lives in `permissions/` and not in a tool file: the epic's
 * invariant 5 — ownership and use are DISTINCT permissions through the
 * centralized permission system, never a tool-only policy. B0 found the
 * confused deputy this exists for: `integration_tool_grants` resolve by
 * `agentId` alone and a `visibility:'private'` personal connection is
 * exercised by anyone who can drive the agent page.
 *
 * `canUserViewPage` — and every page permission, drive membership, workspace
 * ownership or conversation access — grants NOTHING here. A caller holding
 * every page permission and no account relationship gets every permission `false`.
 */
import type { AccountId, AccountKind, AccountOwnerRef, AccountStatus } from '@pagespace/db/schema/agent-accounts';
import type { AgentPageId, CallerCeiling, DelegationFact, DriveId, UserId } from '../agent-accounts/grant';

/**
 * THE one canonical union. `Record<AccountPermission, V>` everywhere
 * per-permission data exists. `session_http` is the default-off exception
 * that lets a `session` kind be resolved by the HTTP executor; it is true
 * only when the account's `sessionHttpEnabled` flag is on (set through
 * `manage`) AND `use` is true (Codex P1 on PR #2637; ADR 0005 §4.2).
 */
export type AccountPermission = 'view' | 'use' | 'manage' | 'grant' | 'session_http';

export type AccountAccessLevel = Readonly<Record<AccountPermission, boolean>>;

/** The HUMAN actor's role in the account's drive, when the account is agent-page-owned. */
export type DriveRoleOfHuman = 'OWNER' | 'ADMIN' | 'MEMBER' | null;

/**
 * The facts the repository fetched — data, never handles. An agent's own
 * drive membership is deliberately absent: it never confers `manage`/`grant`
 * (ADR 0004 §4.1; B0 B-24).
 */
export type AccountAccessFacts = {
  readonly accountId: AccountId;
  readonly kind: AccountKind;
  readonly status: AccountStatus;
  readonly owner: AccountOwnerRef;
  /** The drive of an agent-page-owned account; null for user-owned. */
  readonly accountDriveId: DriveId | null;
  /** Who is asking (the human actor of the request). */
  readonly actorUserId: UserId;
  /** Who the run acts as (`actingUserId` of the dispatch); equals `actorUserId` for a direct request. */
  readonly actingHumanUserId: UserId;
  readonly humanDriveRole: DriveRoleOfHuman;
  /** True iff the human can edit the agent page (for `view` on agent-page-owned accounts only). */
  readonly humanCanEditAgentPage: boolean;
  /** The agent page the current run is driving; null for the global assistant. */
  readonly agentPageId: AgentPageId | null;
  /** Whether that agent page is bound to this account (`agent_account_bindings`, unrevoked). */
  readonly agentBoundToAccount: boolean;
  readonly delegation: DelegationFact;
  /** `agent_accounts.sessionHttpEnabled` — default false; meaningful only for kind `session`. */
  readonly sessionHttpEnabled: boolean;
  readonly callerCeiling: CallerCeiling;
  /** `isDriveWithinCredentialScope(callerCeiling.allowedDriveIds, accountDriveId)` — computed by the repository. */
  readonly ceilingAdmitsAccount: boolean;
};

/** `decideAccountAccess` — pure, one file, options object. G1b implements. */
export type DecideAccountAccess = (input: { readonly facts: AccountAccessFacts }) => AccountAccessLevel;

/** Which permissions require step-up when they WIDEN authority (ADR 0004 §4.1 `grant`). */
export type StepUpRequiredFor = Readonly<Record<AccountPermission, boolean>>;
