/**
 * `decideAccountAccess` — view / use / manage / grant, plus the default-off
 * `session_http` exception, as ONE pure decision over repository-fetched
 * facts (ADR 0004 §4; epic invariant 5).
 *
 * Why every page permission is absent from the rules: `canUserViewPage`,
 * `canUserEditPage`, drive membership, workspace ownership and conversation
 * access grant NOTHING on an account. The confused deputy this exists for
 * (B0): a personal connection exercised by anyone who can drive the agent
 * page. So a user-owned account is USED only by its owner, and only when the
 * owner is the acting human of the run — another member invoking the shared
 * agent gets `use: false` however the page is bound. An agent-page-owned
 * account is used by a drive member driving THAT page; managed and granted
 * by a drive OWNER/ADMIN — the HUMAN actor's role, never the agent's own
 * membership (B0 B-24).
 *
 * The caller ceiling is asked FIRST (axiom 8): a drive-scoped credential
 * reads an account outside its drives as nonexistent — four falses, `view`
 * included. An unattended run needs a live delegation for this account.
 * `session_http` is true only when `use` is true, the account is a
 * `session` kind and its flag is on (ADR 0005 §10.18). Pure.
 */
import { isDriveWithinCredentialScope } from '../agent-workspaces/credential-scope';
import type { DelegationFact } from '../agent-accounts/grant';
import type { AccountAccessFacts, AccountAccessLevel, DecideAccountAccess } from './account-permissions';

const NONE: AccountAccessLevel = { view: false, use: false, manage: false, grant: false, session_http: false };

function delegationHolds(delegation: DelegationFact, accountId: AccountAccessFacts['accountId']): boolean {
  if (delegation.kind === 'live_session') return true;
  if (delegation.kind === 'delegation') return delegation.accountId === accountId && !delegation.expired && !delegation.revoked;
  return false;
}

export const decideAccountAccess: DecideAccountAccess = ({ facts }) => {
  if (!facts.ceilingAdmitsAccount) return NONE;
  if (!isDriveWithinCredentialScope(facts.callerCeiling.allowedDriveIds, facts.accountDriveId)) return NONE;

  const active = facts.status === 'active';
  const delegated = delegationHolds(facts.delegation, facts.accountId);
  const { owner } = facts;

  let view: boolean;
  let use: boolean;
  let manage: boolean;
  let grant: boolean;

  if (owner.kind === 'user') {
    const isOwner = facts.actorUserId === owner.userId;
    const ownerIsActing = facts.actingHumanUserId === owner.userId;
    const bound = facts.agentPageId === null || facts.agentBoundToAccount;
    view = isOwner;
    manage = isOwner;
    grant = isOwner;
    use = isOwner && ownerIsActing && bound && delegated && active;
  } else {
    const role = facts.humanDriveRole;
    const admin = role === 'OWNER' || role === 'ADMIN';
    view = admin || facts.humanCanEditAgentPage;
    manage = admin;
    grant = admin;
    use = role !== null && facts.agentPageId === owner.agentPageId && delegated && active;
  }

  const session_http = use && facts.kind === 'session' && facts.sessionHttpEnabled;
  return { view, use, manage, grant, session_http };
};
