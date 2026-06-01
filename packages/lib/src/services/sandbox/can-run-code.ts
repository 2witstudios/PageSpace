/**
 * Authorization gate for agent code execution.
 *
 * Code execution is the highest-risk surface in the product: the Vercel
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
 * `enabledTools` (agent config) is NOT a security boundary — this is.
 */

import { getValidatedEnv } from '../../config/env-validation';
import type { DrivePermissionLevel, PermissionLevel } from '../../permissions/permissions';

export type CodeExecutionDenialReason =
  | 'kill_switch_off'
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
  getAgentAccessLevel: (
    agentPageId: string,
    targetPageId: string,
  ) => Promise<PermissionLevel | null>;
  isCodeExecutionEnabled: () => boolean;
}

export interface CanRunCodeInput {
  userId: string;
  driveId: string;
  requestOrigin?: 'user' | 'agent';
  agentPageId?: string;
  deps?: CanRunCodeDeps;
}

/**
 * Global kill-switch. Default OFF: only the literal env value 'true' enables
 * execution; an unset/invalid var (or a validation failure) keeps it disabled.
 */
export function isCodeExecutionEnabled(): boolean {
  try {
    return getValidatedEnv().CODE_EXECUTION_ENABLED === 'true';
  } catch {
    return false;
  }
}

// The real authz helpers pull in the database; import them lazily so callers
// that inject fakes (and the unit tests) never load the DB module graph.
const defaultDeps: CanRunCodeDeps = {
  getUserDrivePermissions: (userId, driveId) =>
    import('../../permissions/permissions').then((m) =>
      m.getUserDrivePermissions(userId, driveId),
    ),
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
  if (!perms.isOwner && !perms.isAdmin) return deny('insufficient_role');
  return { ok: true };
}

export async function canRunCode({
  userId,
  driveId,
  requestOrigin = 'user',
  agentPageId,
  deps = defaultDeps,
}: CanRunCodeInput): Promise<CanRunCodeResult> {
  try {
    if (!deps.isCodeExecutionEnabled()) return deny('kill_switch_off');

    return requestOrigin === 'agent'
      ? await authorizeAgent(agentPageId, driveId, deps)
      : await authorizeUser(userId, driveId, deps);
  } catch {
    return deny('error');
  }
}
