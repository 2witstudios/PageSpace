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
  hasAgentDriveAdminRole,
} from '@pagespace/lib/permissions/agent-permissions';
import {
  getCeilingAccessLevel,
  getCeilingDriveMembership,
  getCeilingDriveAccessLevel,
  getCeilingAccessiblePagesInDrive,
  hasCeilingDriveMembership,
  isCeilingDriveOwnerOrAdmin,
} from '@/lib/auth/credential-ceiling';
import type { CredentialCeiling } from '@pagespace/lib/permissions/credential-ceiling';
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
 *
 * Carries the SAME AI_CHAT type gate as resolveActingAgentId — the two seams
 * answer the same question ("is this an agent acting with the user's reach?")
 * and consumers (MachineDirectoryRuntimeDeps.isUserScopedAgent) are documented
 * as mirroring them. The column is AI_CHAT-only by construction today, but a
 * permissions seam does not lean on a schema invariant holding forever: a
 * non-agent row that somehow carries the flag must not widen the machine
 * Settings-toggle exemption.
 */
export async function hasAgentUserScopedAccess(agentPageId: string): Promise<boolean> {
  const row = await fetchActingPageRow(agentPageId);
  return row?.type === PageType.AI_CHAT && row.userScopedAccess;
}

/**
 * The ONE row both actor gates read for `chatSource.agentPageId`: is this page
 * actually an agent (`type`), and has it opted into user-scoped reach
 * (`userScopedAccess`)? Kept as a single select so the type gate below costs
 * zero additional queries on a path every tool call runs through.
 */
async function fetchActingPageRow(agentPageId: string) {
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
 * chatSource carries an id: a chat on any non-AI_CHAT page carries THAT page
 * as agentPageId (api/ai/chat/route.ts sets it for every page chat), and a
 * non-agent page must not be treated as an acting agent — no driveAgentMembers
 * row can ever exist for it, so every getAgentAccessLevel lookup returned null
 * and denied. Falling through to the authenticated user is the honest actor —
 * the chat route already authorized that user against the page. A missing
 * page row is a non-agent for the same reason (and the user's own ACL still
 * denies a page that does not exist).
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
 * The app-member RBAC ceiling, when it applies: a drive-scoped credential — an
 * `mcp_` key (mcp_token_drives) or an OAuth grant (its consented drive rows) —
 * whose own per-drive role caps every tool action. One principal-neutral value
 * (see toolCredentialScope), resolved through one dispatch
 * (lib/auth/credential-ceiling.ts), so no check below can cap one credential
 * kind and forget the other. Callers that set only mcpAllowedDriveIds (no
 * ceiling) keep the scope-only behavior.
 */
function appTokenCeiling(context: ToolExecutionContext): CredentialCeiling | undefined {
  return context.credentialCeiling && isMcpScoped(context) ? context.credentialCeiling : undefined;
}

/**
 * Whether the token's membership row in this drive carries an EXPLICIT role.
 * Inherit rows (role NULL) apply NO tool-layer ceiling: the key acts as its
 * owner, the route gate already ran the owner's access, and an agent actor
 * keeps its own ACL (pre-RBAC behavior). Explicit roles cap deny-only.
 */
async function hasExplicitAppRole(
  context: ToolExecutionContext,
  ceiling: CredentialCeiling,
  driveId: string,
): Promise<boolean> {
  const membership = await getCeilingDriveMembership(ceiling, context.userId, driveId);
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
  const ceiling = appTokenCeiling(context);
  if (!ceiling) return false;
  const [row] = await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, pageId));
  const driveId = row?.driveId ?? pageId;
  if (!(await hasExplicitAppRole(context, ceiling, driveId))) return false;
  const level = await getCeilingAccessLevel(ceiling, context.userId, pageId);
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

/**
 * How many parent hops the own-subtree walk below will follow before giving
 * up. Page trees are shallow in practice; the bound only turns a pathological
 * or cyclic parent chain into a denial instead of a hang.
 */
const AGENT_SUBTREE_WALK_LIMIT = 32;

/**
 * Whether `pageId` is the acting agent's own page or one of its descendants.
 *
 * An agent's own subtree is the one space it is meant to author: the Agent
 * Memory feature (lib/ai/core/agent-memory.ts) instructs every AI_CHAT agent
 * to create and edit an "Agent Memory" child of its own page, but the default
 * drive membership (MEMBER) resolves canEdit:false on every non-channel page,
 * so every write there was refused — create_page against the agent page as
 * parent and every line edit on the memory page alike (cron workflow runs fail
 * this way since the workflow executor began carrying the agent identity into
 * the tool context). Children of the agent page can only come to exist by an
 * actor already passing the edit gate on the agent page, so the subtree
 * carries no authority the agent was not already trusted with.
 *
 * Delete is deliberately NOT granted by this walk — an agent must not be able
 * to trash its own page (or its memory) even though it may write them.
 */
async function isAgentOwnedPage(agentPageId: string, pageId: string): Promise<boolean> {
  let currentId: string | null = pageId;
  for (let hops = 0; currentId && hops < AGENT_SUBTREE_WALK_LIMIT; hops++) {
    if (currentId === agentPageId) return true;
    const [row] = await db
      .select({ parentId: pages.parentId })
      .from(pages)
      .where(eq(pages.id, currentId));
    currentId = row?.parentId ?? null;
  }
  return false;
}

export async function canActorEditPage(
  context: ToolExecutionContext,
  pageId: string,
): Promise<boolean> {
  if (await pageOutsideMcpScope(context, pageId)) return false;
  if (await pageDeniedByAppToken(context, pageId, 'edit')) return false;
  const agentPageId = await resolveActingAgentId(context);
  if (agentPageId) {
    if (await isAgentOwnedPage(agentPageId, pageId)) return true;
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

/**
 * Whether the actor may CONSULT (ask) an agent — the one rule shared by the
 * invoke-an-agent engine (executeAskAgent) and the channel-mention responder,
 * so the responder's preliminary gate and the engine's own gate can never
 * disagree.
 *
 * Viewing the agent's page is sufficient. It is not necessary: an agent that
 * is a MEMBER of the drive the actor is operating in was added there (by an
 * owner/admin/member, see drive-agent-service) precisely so that drive's
 * members can talk to it, and the drive's agent-members list already shows it
 * to every member. A guest agent — homed in a drive the actor cannot see —
 * is exactly this case. So the second grant is: the agent is a member of
 * `currentDriveId` (falling back to the actor's locationContext drive) AND
 * the actor can access that drive under its own ceiling (canActorAccessDrive:
 * MCP scope, app-token ceiling, agent membership or user access).
 */
export async function canActorConsultAgent(
  context: ToolExecutionContext,
  agentPageId: string,
  currentDriveId?: string | null,
): Promise<boolean> {
  if (await canActorViewPage(context, agentPageId)) return true;
  const driveId = currentDriveId ?? context.locationContext?.currentDrive?.id ?? null;
  if (!driveId) return false;
  if (!(await hasAgentDriveMembership(agentPageId, driveId))) return false;
  return canActorAccessDrive(context, driveId);
}

export async function canActorAccessDrive(
  context: ToolExecutionContext,
  driveId: string,
): Promise<boolean> {
  if (driveOutsideMcpScope(context, driveId)) return false;
  // Membership ceiling only (not drive-level view): callers page-filter their
  // results via getActorAccessiblePagesInDrive / canActorViewPage, so a token
  // with only per-page custom-role grants keeps access to those pages.
  const ceiling = appTokenCeiling(context);
  if (ceiling && !(await hasCeilingDriveMembership(ceiling, context.userId, driveId))) {
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
  return driveGateWithAgentCheck(context, driveId, hasAgentDriveMembership);
}

/**
 * Shared body of the two drive-level gates. The MCP scope ceiling, the
 * app-token ceiling and the user owner/admin fallback are identical for both
 * and MUST stay that way — if one of those ever tightens and only one gate
 * picks it up, the looser gate becomes the way in. Only the agent question
 * differs, so that is the one thing injected.
 */
async function driveGateWithAgentCheck(
  context: ToolExecutionContext,
  driveId: string,
  agentCheck: (agentPageId: string, driveId: string) => Promise<boolean>,
): Promise<boolean> {
  if (driveOutsideMcpScope(context, driveId)) return false;
  if (await driveDeniedByAppToken(context, driveId, 'manage')) return false;
  const agentPageId = await resolveActingAgentId(context);
  if (agentPageId) return agentCheck(agentPageId, driveId);
  const access = await checkDriveAccess(driveId, context.userId);
  return access.isOwner || access.isAdmin;
}

/**
 * Whether the actor may ADMINISTER a drive — the owner/admin bar, enforced
 * uniformly for user and agent actors alike.
 *
 * Deliberately separate from `canActorManageDrive`. That helper resolves an
 * agent actor to `hasAgentDriveMembership`, a bare row-existence check that
 * ignores `role`, which is the right model for tools whose reach is already
 * bounded by the agent's enabledTools allowlist. It is the WRONG model for
 * accepting content into a drive from outside it: a plain MEMBER agent would
 * clear a bar that /api/pages/bulk-move denies to a human without OWNER/ADMIN,
 * and the moved subtree would land in a drive on weaker authority than the REST
 * path requires. Used by the cross-drive move's destination check.
 */
export async function canActorAdministerDrive(
  context: ToolExecutionContext,
  driveId: string,
): Promise<boolean> {
  return driveGateWithAgentCheck(context, driveId, hasAgentDriveAdminRole);
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
  const ceiling = appTokenCeiling(context);
  if (!ceiling) return actorPages;
  // Inherit rows apply no ceiling — the key acts as its owner.
  if (!(await hasExplicitAppRole(context, ceiling, driveId))) return actorPages;

  // App-member ceiling: intersect with the token's own accessible set, AND-ing
  // each permission flag so the token never exceeds its explicit membership role.
  const tokenPages = new Map(
    (await getCeilingAccessiblePagesInDrive(ceiling, context.userId, driveId)).map((p) => [p.id, p.permissions]),
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
  const ceiling = appTokenCeiling(context);
  if (!ceiling) return false;
  const membership = await getCeilingDriveMembership(ceiling, context.userId, driveId);
  if (!membership) return true;
  // Inherit: no tool-layer ceiling — the key acts as its owner.
  if (membership.role === null) return false;
  if (need === 'manage') {
    // Explicit ADMIN/OWNER, and only while the USER is still owner/admin.
    return !(await isCeilingDriveOwnerOrAdmin(ceiling, context.userId, driveId));
  }
  const level = await getCeilingDriveAccessLevel(ceiling, context.userId, driveId);
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
  if (!appTokenCeiling(context)) return scoped;
  const results = await Promise.all(
    scoped.map(async (driveId) => (await driveDeniedByAppToken(context, driveId, 'view')) ? null : driveId),
  );
  return results.filter((id): id is string => id !== null);
}
