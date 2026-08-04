/**
 * Authorization gate for agent code execution.
 *
 * Code execution is the highest-risk surface in the product: the Fly Sprite
 * microVM contains the risk of *escape*, but authorization, kill-switch, and
 * quota gating are entirely ours. `canRunCode` composes the existing
 * drive-permission helpers and is the single chokepoint every invocation must pass.
 *
 * Fail-closed by construction: it never throws — any error (including a DB
 * outage inside an injected dependency) resolves to a denial. The kill-switch
 * is checked first (cheap, no DB) so a disabled feature denies before any
 * database round-trip.
 *
 * No deployment-mode gate: tenant is cloud (isolated image per tenant) and we
 * do not serve on-prem (a local execution path is future work, not wired here),
 * so gating on DEPLOYMENT_MODE / isOnPrem would only add a dead branch.
 *
 * Tier gate, not admin gate: the sandbox is a paid feature (Pro tier and
 * above) — session/chat/panes/GitHub-tool access is open to every
 * authenticated user, but running code costs real compute, so this chokepoint
 * checks the session's PAYER's subscription tier (drive owner, or the
 * session's own owner when driveless), not the acting user's own tier —
 * see `resolveSandboxPayerTier`. A free-tier member of a Pro-owned drive is
 * still eligible, billed to the drive's owner, matching how billing/quota
 * already resolve tier.
 *
 * The actor user always clears the drive edit-access gate (owner, admin, or
 * MEMBER-role collaborator — a VIEWER cannot spend the payer's compute),
 * regardless of origin. Agent-origin runs additionally require the agent page
 * to hold drive edit access (defence in depth): both the human who triggered
 * the run and the agent acting on their behalf must be entitled, so a viewer
 * can't escalate through an agent that happens to have edit access.
 *
 * `enabledTools` (agent config) is NOT a security boundary — this is.
 */

import type { DrivePermissionLevel, PermissionLevel } from '../../permissions/permissions';
import { resolveSandboxPayerTier, isSandboxAvailable } from '../../billing/sandbox-eligibility';
import type { SubscriptionTier } from '../../billing/subscription-tiers';

export type CodeExecutionDenialReason =
  | 'kill_switch_off'
  | 'tier_ineligible'
  | 'no_drive_access'
  | 'insufficient_role'
  | 'no_agent_access'
  | 'error';

export type CanRunCodeResult =
  | { ok: true }
  | { ok: false; reason: CodeExecutionDenialReason };

/**
 * IO dependencies, injected so tests exercise the composition logic with fakes
 * instead of mocking the database. Defaults wire the real implementations.
 */
export interface CanRunCodeDeps {
  getUserDrivePermissions: (
    userId: string,
    driveId: string,
  ) => Promise<DrivePermissionLevel | null>;
  lookupDriveOwnerId: (driveId: string) => Promise<string | null>;
  getUserSubscriptionTier: (userId: string) => Promise<SubscriptionTier>;
  getAgentAccessLevel: (
    agentPageId: string,
    targetPageId: string,
  ) => Promise<PermissionLevel | null>;
  isCodeExecutionEnabled: () => boolean;
}

export interface CanRunCodeInput {
  userId: string;
  /** Absent for global (non-drive) contexts; drive-scoped checks are skipped when
   *  driveId is not provided. */
  driveId?: string;
  /** The session's own owner — distinct from `userId` (the actor) — used to
   *  resolve the PAYER for the tier-eligibility gate. Falls back to `userId`
   *  when a call site hasn't threaded it yet (denies more strictly, never
   *  grants incorrectly). */
  ownerId?: string;
  requestOrigin?: 'user' | 'agent';
  agentPageId?: string;
  deps?: CanRunCodeDeps;
}

/**
 * Global kill-switch. Default OFF: only the literal env value 'true' enables
 * execution; an unset value keeps it disabled.
 *
 * Read directly from `process.env`, NOT via `getValidatedEnv()`: this gate runs
 * in BOTH the web app and the realtime service (the terminal PTY auth path), and
 * realtime's lean env does not satisfy the full web schema — `getValidatedEnv()`
 * THROWS there, which previously flipped the switch OFF and denied every terminal
 * with `kill_switch_off` even when the flag was on. The flag is a non-secret
 * string, so a direct, service-agnostic read is correct here.
 */
export function isCodeExecutionEnabled(): boolean {
  return process.env.CODE_EXECUTION_ENABLED === 'true';
}

// The real authz helpers pull in the database; import them lazily so callers
// that inject fakes (and the unit tests) never load the DB module graph.
const defaultDeps: CanRunCodeDeps = {
  getUserDrivePermissions: (userId, driveId) =>
    import('../../permissions/permissions').then((m) =>
      m.getUserDrivePermissions(userId, driveId),
    ),
  lookupDriveOwnerId: (driveId) =>
    import('../../billing/sandbox-payer').then((m) => m.lookupDriveOwnerId(driveId)),
  getUserSubscriptionTier: async (userId) => {
    const [{ db }, { eq }, { users }, { toSubscriptionTier }] = await Promise.all([
      import('@pagespace/db/db'),
      import('@pagespace/db/operators'),
      import('@pagespace/db/schema/auth'),
      import('../../billing/subscription-tiers'),
    ]);
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { subscriptionTier: true },
    });
    return toSubscriptionTier(user?.subscriptionTier);
  },
  getAgentAccessLevel: (agentPageId, targetPageId) =>
    import('../../permissions/agent-permissions').then((m) =>
      m.getAgentAccessLevel(agentPageId, targetPageId),
    ),
  isCodeExecutionEnabled,
};

const deny = (reason: CodeExecutionDenialReason): CanRunCodeResult => ({
  ok: false,
  reason,
});

async function authorizeAgent(
  agentPageId: string | undefined,
  driveId: string,
  deps: CanRunCodeDeps,
): Promise<CanRunCodeResult> {
  if (!agentPageId) return deny('no_agent_access');
  // Pass driveId as the target: getAgentAccessLevel resolves an id with no page
  // row to a drive (the drive-as-root-node fallback in agent-permissions.ts),
  // so this evaluates the agent's drive-level access.
  const access = await deps.getAgentAccessLevel(agentPageId, driveId);
  if (!access?.canEdit) return deny('no_agent_access');
  return { ok: true };
}

async function authorizeUser(
  userId: string,
  driveId: string,
  deps: CanRunCodeDeps,
): Promise<CanRunCodeResult> {
  const perms = await deps.getUserDrivePermissions(userId, driveId);
  if (!perms?.hasAccess) return deny('no_drive_access');
  // Edit access, not owner/admin (review #2326): the owner/admin gate was a
  // rollout-era restriction from when the whole surface was admin-only. Under
  // the open model the advertised entitlement is "every member of a paid
  // drive gets the sandbox" — MEMBER-role collaborators have canEdit and
  // pass; VIEWER-role members don't get to spend the payer's compute or
  // write in the shared workspace, exactly as they can't edit its pages.
  if (!perms.canEdit) return deny('insufficient_role');
  return { ok: true };
}

async function authorizeSandboxTierEligibility(
  userId: string,
  driveId: string | undefined,
  ownerId: string | undefined,
  deps: CanRunCodeDeps,
): Promise<CanRunCodeResult> {
  const tier = await resolveSandboxPayerTier(
    { driveId: driveId ?? null, ownerId: ownerId ?? userId },
    { lookupDriveOwnerId: deps.lookupDriveOwnerId, getUserSubscriptionTier: deps.getUserSubscriptionTier },
  );
  return isSandboxAvailable(tier) ? { ok: true } : deny('tier_ineligible');
}

export async function canRunCode({
  userId,
  driveId,
  ownerId,
  requestOrigin = 'user',
  agentPageId,
  deps = defaultDeps,
}: CanRunCodeInput): Promise<CanRunCodeResult> {
  try {
    if (!deps.isCodeExecutionEnabled()) return deny('kill_switch_off');

    const tierResult = await authorizeSandboxTierEligibility(userId, driveId, ownerId, deps);
    if (!tierResult.ok) return tierResult;

    // Drive-scoped checks are intentionally skipped when no driveId is present
    // (global context): the absence of a drive is a valid, expected state for the
    // global assistant, not an error. The entry point (resolveSandboxActorContext)
    // is the only layer that knows whether no-driveId is intentional, and it
    // enforces this via chatSource.type discrimination before reaching here.
    //
    // Agent-origin runs always require a drive context for proper authorization.
    // A consulted page agent invoked from the global assistant still sets
    // requestOrigin='agent'; without a driveId we cannot verify the agent's drive
    // access, so we deny rather than allow an unchecked agent escalation.
    if (!driveId) {
      if (requestOrigin === 'agent') return deny('no_agent_access');
      return { ok: true };
    }

    // The actor user must always clear the drive edit-access gate. For
    // agent-origin runs this is the rung that stops a view-only member
    // escalating through an agent that holds drive edit access.
    const userResult = await authorizeUser(userId, driveId, deps);
    if (!userResult.ok) return userResult;

    // Agent-origin runs additionally require the agent page itself to hold
    // drive edit access — both the actor and the agent must be entitled.
    return requestOrigin === 'agent'
      ? await authorizeAgent(agentPageId, driveId, deps)
      : userResult;
  } catch {
    return deny('error');
  }
}
