import type { ToolExecutionContext } from '../core/types';
import {
  getUserAccessLevel,
  getUserDriveAccess,
  canUserEditPage,
  canUserDeletePage,
  getUserAccessiblePagesInDriveWithDetails,
  type PageWithPermissions,
} from '@pagespace/lib/permissions/permissions';
import {
  getAgentAccessLevel,
  getAgentAccessiblePagesInDrive,
  hasAgentDriveMembership,
} from '@pagespace/lib/permissions/agent-permissions';
import {
  getAppAccessLevel,
  getAppDriveMembership,
  getAppDriveAccessLevel,
  getAppAccessiblePagesInDrive,
  hasAppDriveMembership,
} from '@pagespace/lib/permissions/app-permissions';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
import { PageType } from '@pagespace/lib/utils/enums';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';

export function getAgentPageId(context: ToolExecutionContext): string | undefined {
  return context.chatSource?.type === 'page' ? context.chatSource.agentPageId : undefined;
}

/**
 * Whether a page-agent has opted into user-scoped reach (`pages.userScopedAccess`,
 * owner-toggled via update_agent_config, default false). When true, tools that
 * would otherwise confine the agent to its own drive memberships should fall
 * back to the invoking user's own access instead — for personal/global-style
 * assistants that need the user's full reach rather than explicit membership.
 */
export async function hasAgentUserScopedAccess(agentPageId: string): Promise<boolean> {
  return (await fetchActingPageRow(agentPageId))?.userScopedAccess ?? false;
}

/**
 * The ONE row both actor gates read for `chatSource.agentPageId`: is this page
 * actually an agent (`type`), and has it opted into user-scoped reach
 * (`userScopedAccess`)? Kept as a single select so the type gate below costs
 * zero additional queries on a path every tool call runs through.
 */
async function fetchActingPageRow(
  agentPageId: string,
): Promise<{ type: string; userScopedAccess: boolean } | undefined> {
  const [row] = await db
    .select({ type: pages.type, userScopedAccess: pages.userScopedAccess })
    .from(pages)
    .where(eq(pages.id, agentPageId));
  return row;
}

/**
 * The agent id the canActor* helpers should authorize as, or undefined when
 * the caller is not a page-agent OR the agent has user-scoped access — in
 * both cases the helpers fall through to the invoking user's own access.
 * Invoker-scoped by design: a user-scoped agent acts with the CURRENT
 * chatter's reach, never its owner's.
 *
 * "Not a page-agent" is a claim about the PAGE, not just about whether a
 * chatSource carries an id: a machine-pane conversation carries the MACHINE
 * page as agentPageId (api/ai/chat/route.ts sets it for every page chat), and a
 * non-agent page must not be treated as an acting agent — no driveAgentMembers
 * row can ever exist for it, so every getAgentAccessLevel lookup returned null
 * and denied. Falling through to the authenticated user is the honest actor and
 * matches the PTY path; the chat route already authorized that user against the
 * machine page. A missing page row is a non-agent for the same reason (and the
 * user's own ACL still denies a page that does not exist).
 *
 * Nested (ask_agent) runs inherit the PARENT's actor identity by design —
 * agent-communication-tools.ts spreads the caller's context, and
 * sandbox-tools-runtime's activeMachineAgentPageId documents the same "the
 * agent's own page or the parent's for a sub-agent" rule. So a consulted agent
 * reached FROM a machine pane also resolves to the invoking user: bounded by
 * that user's own ACL, never beyond it, and never wider than what the pane's
 * own tools already reach. Before this gate that whole path was dead, not
 * tighter — ask_agent's own canActorViewPage gate denied at the door.
 *
 * Exported for tools that branch on the same "is this a membership-scoped
 * agent, or should it fall through to the user's own reach" question outside
 * these chokepoints (e.g. drive discovery/creation) — reuse this instead of
 * re-deriving `getAgentPageId(context) && !hasAgentUserScopedAccess(...)` inline.
 */
export async function resolveActingAgentId(context: ToolExecutionContext): Promise<string | undefined> {
  const agentPageId = getAgentPageId(context);
  if (!agentPageId) return undefined;
  const row = await fetchActingPageRow(agentPageId);
  if (row?.type !== PageType.AI_CHAT) return undefined;
  return row.userScopedAccess ? undefined : agentPageId;
}

/**
 * Whether the caller carries an MCP drive-scope restriction (a non-empty
 * allowedDriveIds). Empty/undefined means full access — session auth or an
 * unscoped token — and skips all scope checks.
 *
 * Exported as `isMcpScoped` for tools that should be blocked entirely for
 * drive-scoped tokens (e.g. creating a brand-new drive), mirroring the
 * /api/mcp/drives REST gate.
 */
export function isMcpScoped(context: ToolExecutionContext): boolean {
  return (context.mcpAllowedDriveIds?.length ?? 0) > 0;
}

function hasMcpScope(context: ToolExecutionContext): boolean {
  return isMcpScoped(context);
}

/**
 * Whether the app-member RBAC ceiling applies: a drive-scoped MCP token whose
 * own membership role (mcp_token_drives) caps every tool action. Older callers
 * that set only mcpAllowedDriveIds (no token id) keep the scope-only behavior.
 */
function hasAppTokenCeiling(context: ToolExecutionContext): boolean {
  return !!context.mcpTokenId && isMcpScoped(context);
}

/**
 * Whether the token's membership row in this drive carries an EXPLICIT role.
 * Inherit rows (role NULL) apply NO tool-layer ceiling: the key acts as its
 * owner, the route gate already ran the owner's access, and an agent actor
 * keeps its own ACL (pre-RBAC behavior). Explicit roles cap deny-only.
 */
async function hasExplicitAppRole(
  context: ToolExecutionContext,
  driveId: string,
): Promise<boolean> {
  const membership = await getAppDriveMembership(context.mcpTokenId!, driveId);
  return membership !== null && membership.role !== null;
}

/**
 * Deny-only page-level cap from the token's own drive-membership role. Returns
 * true when the ceiling applies and the token's role does NOT grant the needed
 * permission. Never grants anything the actor's own ACL would deny; a no-op
 * for inherited (role NULL) memberships.
 */
async function pageDeniedByAppToken(
  context: ToolExecutionContext,
  pageId: string,
  need: 'view' | 'edit' | 'delete',
): Promise<boolean> {
  if (!hasAppTokenCeiling(context)) return false;
  const [row] = await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, pageId));
  const driveId = row?.driveId ?? pageId;
  if (!(await hasExplicitAppRole(context, driveId))) return false;
  const level = await getAppAccessLevel(context.mcpTokenId!, pageId);
  if (!level) return true;
  switch (need) {
    case 'view': return !level.canView;
    case 'edit': return !level.canEdit;
    case 'delete': return !level.canDelete;
  }
}

/**
 * True when a scoped MCP caller is trying to reach a drive outside its token
 * scope. The actor's own ACL (user or agent) is checked separately; this is an
 * additional ceiling that a scoped token can never exceed, mirroring
 * checkMCPDriveScope on the REST surface.
 *
 * Exported so tools that authorize via primitives OTHER than the canActor*
 * chokepoint (e.g. activity, calendar, member listing) can apply the same
 * ceiling without changing their existing permission logic. Deny-only and a
 * no-op for unscoped callers, so it never affects the in-app product.
 */
export function driveOutsideMcpScope(context: ToolExecutionContext, driveId: string): boolean {
  if (!hasMcpScope(context)) return false;
  return !context.mcpAllowedDriveIds!.includes(driveId);
}

/**
 * Filter a list of drive IDs down to those a scoped MCP token may reach.
 * Returns the input unchanged for unscoped callers (full access).
 */
export function filterDriveIdsByMcpScope(
  context: ToolExecutionContext,
  driveIds: string[],
): string[] {
  if (!hasMcpScope(context)) return driveIds;
  const allowed = new Set(context.mcpAllowedDriveIds);
  return driveIds.filter((id) => allowed.has(id));
}

/**
 * Page-level equivalent: resolves the page's drive (only when a scope is active)
 * and checks it against the token scope.
 *
 * The create_page root path authorizes by passing the DRIVE id to
 * canActorEditPage ("the drive is the parent of root pages"), so when no page
 * row matches we fall back to treating the id as a drive id and checking that
 * against the scope. A genuinely unknown id matches neither and stays
 * fail-closed (the actor ACL would reject it anyway).
 */
async function pageOutsideMcpScope(context: ToolExecutionContext, pageId: string): Promise<boolean> {
  if (!hasMcpScope(context)) return false;
  const [row] = await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, pageId));
  const driveId = row?.driveId ?? pageId;
  return !context.mcpAllowedDriveIds!.includes(driveId);
}

export async function canActorEditPage(
  context: ToolExecutionContext,
  pageId: string,
): Promise<boolean> {
  if (await pageOutsideMcpScope(context, pageId)) return false;
  if (await pageDeniedByAppToken(context, pageId, 'edit')) return false;
  const agentPageId = await resolveActingAgentId(context);
  if (agentPageId) {
    const perms = await getAgentAccessLevel(agentPageId, pageId);
    return perms?.canEdit ?? false;
  }
  return canUserEditPage(context.userId, pageId);
}

export async function canActorDeletePage(
  context: ToolExecutionContext,
  pageId: string,
): Promise<boolean> {
  if (await pageOutsideMcpScope(context, pageId)) return false;
  if (await pageDeniedByAppToken(context, pageId, 'delete')) return false;
  const agentPageId = await resolveActingAgentId(context);
  if (agentPageId) {
    const perms = await getAgentAccessLevel(agentPageId, pageId);
    return perms?.canDelete ?? false;
  }
  return canUserDeletePage(context.userId, pageId);
}

export async function canActorViewPage(
  context: ToolExecutionContext,
  pageId: string,
): Promise<boolean> {
  if (await pageOutsideMcpScope(context, pageId)) return false;
  if (await pageDeniedByAppToken(context, pageId, 'view')) return false;
  const agentPageId = await resolveActingAgentId(context);
  if (agentPageId) {
    const perms = await getAgentAccessLevel(agentPageId, pageId);
    return perms?.canView ?? false;
  }
  const perms = await getUserAccessLevel(context.userId, pageId);
  return perms?.canView ?? false;
}

export async function canActorAccessDrive(
  context: ToolExecutionContext,
  driveId: string,
): Promise<boolean> {
  if (driveOutsideMcpScope(context, driveId)) return false;
  // Membership ceiling only (not drive-level view): callers page-filter their
  // results via getActorAccessiblePagesInDrive / canActorViewPage, so a token
  // with only per-page custom-role grants keeps access to those pages.
  if (hasAppTokenCeiling(context) && !(await hasAppDriveMembership(context.mcpTokenId!, driveId))) {
    return false;
  }
  const agentPageId = await resolveActingAgentId(context);
  if (agentPageId) return hasAgentDriveMembership(agentPageId, driveId);
  return getUserDriveAccess(context.userId, driveId);
}

/**
 * Whether the actor may manage drive-level resources that require elevated
 * authority — currently standalone cron workflows. Mirrors the workflows REST
 * API (apps/web/src/app/api/workflows/route.ts), which gates on owner/admin.
 *
 * User actors must be the drive owner or an admin (not merely a member or a
 * page-permission grantee). Agent actors are gated by their drive membership —
 * the same authority model used by every other agent write tool — since which
 * agents may schedule workflows is controlled by the agent's enabledTools
 * allowlist, configured by an owner/admin.
 */
export async function canActorManageDrive(
  context: ToolExecutionContext,
  driveId: string,
): Promise<boolean> {
  if (driveOutsideMcpScope(context, driveId)) return false;
  if (await driveDeniedByAppToken(context, driveId, 'manage')) return false;
  const agentPageId = await resolveActingAgentId(context);
  if (agentPageId) return hasAgentDriveMembership(agentPageId, driveId);
  const access = await checkDriveAccess(driveId, context.userId);
  return access.isOwner || access.isAdmin;
}

export async function getActorAccessiblePagesInDrive(
  context: ToolExecutionContext,
  driveId: string,
): Promise<PageWithPermissions[]> {
  if (driveOutsideMcpScope(context, driveId)) return [];
  const agentPageId = await resolveActingAgentId(context);
  const actorPages = agentPageId
    ? await getAgentAccessiblePagesInDrive(agentPageId, driveId)
    : await getUserAccessiblePagesInDriveWithDetails(context.userId, driveId);
  if (!hasAppTokenCeiling(context)) return actorPages;
  // Inherit rows apply no ceiling — the key acts as its owner.
  if (!(await hasExplicitAppRole(context, driveId))) return actorPages;

  // App-member ceiling: intersect with the token's own accessible set, AND-ing
  // each permission flag so the token never exceeds its explicit membership role.
  const tokenPages = new Map(
    (await getAppAccessiblePagesInDrive(context.mcpTokenId!, driveId)).map((p) => [p.id, p.permissions]),
  );
  return actorPages
    .filter((p) => tokenPages.get(p.id)?.canView)
    .map((p) => {
      const cap = tokenPages.get(p.id)!;
      return {
        ...p,
        permissions: {
          canView: p.permissions.canView && cap.canView,
          canEdit: p.permissions.canEdit && cap.canEdit,
          canShare: p.permissions.canShare && cap.canShare,
          canDelete: p.permissions.canDelete && cap.canDelete,
        },
      };
    });
}

/**
 * Drive-level app-member ceiling for tools that authorize via primitives other
 * than the canActor* chokepoint (activity, calendar, member listing). Combines
 * the sync drive-scope check with the token's own membership role: deny-only
 * and a no-op for sessions, unscoped tokens, and contexts without a token id.
 */
export async function driveDeniedByAppToken(
  context: ToolExecutionContext,
  driveId: string,
  need: 'view' | 'edit' | 'manage' = 'view',
): Promise<boolean> {
  if (driveOutsideMcpScope(context, driveId)) return true;
  if (!hasAppTokenCeiling(context)) return false;
  const membership = await getAppDriveMembership(context.mcpTokenId!, driveId);
  if (!membership) return true;
  // Inherit: no tool-layer ceiling — the key acts as its owner.
  if (membership.role === null) return false;
  if (need === 'manage') {
    return membership.role !== 'OWNER' && membership.role !== 'ADMIN';
  }
  const level = await getAppDriveAccessLevel(context.mcpTokenId!, driveId);
  if (!level) return true;
  return need === 'edit' ? !level.canEdit : !level.canView;
}

/**
 * Role-aware variant of filterDriveIdsByMcpScope: drops drives outside the
 * token scope AND drives where the token's own role grants no view access.
 */
export async function filterDriveIdsByAppTokenScope(
  context: ToolExecutionContext,
  driveIds: string[],
): Promise<string[]> {
  const scoped = filterDriveIdsByMcpScope(context, driveIds);
  if (!hasAppTokenCeiling(context)) return scoped;
  const results = await Promise.all(
    scoped.map(async (driveId) => (await driveDeniedByAppToken(context, driveId, 'view')) ? null : driveId),
  );
  return results.filter((id): id is string => id !== null);
}
