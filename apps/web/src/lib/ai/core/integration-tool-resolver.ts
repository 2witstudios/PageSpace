/**
 * Integration Tool Resolver
 *
 * Shared helper used by both the page agent chat route and the global assistant route
 * to resolve and convert integration tools into AI SDK format.
 */

import { db } from '@pagespace/db/db';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import {
  resolveAgentIntegrations,
  resolveGlobalAssistantIntegrations,
  type ResolutionDependencies,
} from '@pagespace/lib/integrations/resolution/resolve-agent-integrations';
import {
  convertIntegrationToolsToAISDK,
  type CoreTool,
  type GrantWithConnectionAndProvider,
} from '@pagespace/lib/integrations/converter/ai-sdk';
import { createConfiguredToolExecutor } from '@pagespace/lib/integrations/saga/create-configured-executor';
import {
  listUserConnections,
  listDriveConnections,
} from '@pagespace/lib/integrations/repositories/connection-repository';
import { listGrantsByAgent } from '@pagespace/lib/integrations/repositories/grant-repository';
import { getConfig } from '@pagespace/lib/integrations/repositories/config-repository';
import { type DriveRole, type GlobalAssistantConfigData } from '@pagespace/lib/integrations/types';
import { suppressGithubIntegrationTools } from './tool-filtering';
import { findBuiltinAgentOwner, loadImagoAgentContext } from './imago-agent-context';

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════════════════

function createResolutionDeps(): ResolutionDependencies {
  return {
    listGrantsByAgent: (agentId) =>
      listGrantsByAgent(db, agentId) as Promise<GrantWithConnectionAndProvider[]>,
    listUserConnections: (userId) => listUserConnections(db, userId),
    listDriveConnections: (driveId) => listDriveConnections(db, driveId),
    getAssistantConfig: (userId) =>
      getConfig(db, userId) as Promise<GlobalAssistantConfigData | null>,
  };
}

/**
 * Convert resolved grants into AI SDK tools executed (and audited) as
 * `context`, minus GitHub OAuth tools the sandbox toolkit already covers.
 */
function toSortedAISDKTools(
  grants: GrantWithConnectionAndProvider[],
  context: { userId: string; agentId: string | null; driveId: string | null },
  currentTools: Record<string, unknown>
): Record<string, CoreTool> {
  if (grants.length === 0) return {};

  const executor = createConfiguredToolExecutor({ db, ...context });

  const tools = suppressGithubIntegrationTools(
    convertIntegrationToolsToAISDK(grants, context, executor),
    currentTools
  );
  // Sort keys so tool array order is deterministic across requests (only real config
  // changes — webSearch/readOnly/MCP/exposure-mode — may change the tool array).
  return Object.fromEntries(Object.keys(tools).sort().map(k => [k, tools[k]]));
}

/**
 * The drive whose integrations a user-level assistant may draw on, and the
 * user's role there: `driveId` only when the user is a member of it (a page
 * share alone grants no drive integrations), else `null` with no role.
 */
export async function resolveIntegrationDriveScope(
  userId: string,
  driveId: string | null
): Promise<{ driveId: string | null; userDriveRole: DriveRole | null }> {
  if (!driveId) return { driveId: null, userDriveRole: null };
  const access = await getDriveAccess(driveId, userId);
  return access.isMember ? { driveId, userDriveRole: access.role } : { driveId: null, userDriveRole: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE AGENT RESOLVER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve integration tools for a page agent (AI_CHAT page with grants) — the
 * ONE entry point for every way an agent runs outside its own page chat
 * (ask_agent, the consult route, workflow and trigger runs).
 *
 * A built-in Imago agent never gets per-agent `integration_tool_grants`. Run by
 * its owner it resolves exactly as in its own chat — the Global Assistant's
 * integrations (`resolveAssistantIntegrationTools`), drive ones from
 * `contextDriveId` unless the user keeps Imago out of that drive or the
 * caller's token scope excludes it; run by anyone else it gets none.
 *
 * @param params.agentId - The page ID of the AI_CHAT agent
 * @param params.userId - The authenticated user's ID
 * @param params.driveId - The drive containing the agent
 * @param params.currentTools - The agent's already-resolved tool set (before
 *   these integration tools are merged in), used to suppress GitHub OAuth
 *   integration tools when the sandbox git/gh CLI toolkit is already present.
 *   Callers must pass the pre-tool-exposure-mode set — search mode defers
 *   non-core tools behind execute_tool, hiding their names from a key scan.
 * @param params.contextDriveId - The drive the run is working in, if any
 *   (only an Imago agent reads it)
 * @param params.allowedDriveIds - The caller's token drive scope (empty =
 *   unscoped), applied to an Imago agent's drive in view
 * @returns AI SDK tool objects ready for merging into the tool set
 */
export async function resolvePageAgentIntegrationTools(params: {
  agentId: string;
  userId: string;
  driveId: string;
  currentTools: Record<string, unknown>;
  contextDriveId?: string | null;
  allowedDriveIds?: readonly string[];
}): Promise<Record<string, CoreTool>> {
  const { agentId, userId, driveId, currentTools, contextDriveId = null, allowedDriveIds = [] } = params;

  const builtinOwnerId = await findBuiltinAgentOwner(agentId);
  if (builtinOwnerId !== null) {
    if (builtinOwnerId !== userId) return {};
    // Throws on failure: callers degrade to no integration tools (fail closed).
    const imagoContext = await loadImagoAgentContext({ userId, agentPageId: agentId });
    if (!imagoContext || isOnPrem()) return {};
    const inScope = contextDriveId !== null &&
      !imagoContext.excludedDriveIds.has(contextDriveId) &&
      (allowedDriveIds.length === 0 || allowedDriveIds.includes(contextDriveId));
    return resolveAssistantIntegrationTools({
      userId,
      agentId,
      driveInView: inScope ? contextDriveId : null,
      currentTools,
    });
  }

  const deps = createResolutionDeps();

  const grants = await resolveAgentIntegrations(deps, agentId);

  return toSortedAISDKTools(grants, { userId, agentId, driveId }, currentTools);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL ASSISTANT RESOLVER (shared with Imago)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve the Global Assistant's integration tools — and Imago's, which
 * replaces it one for one (IMG-10.10), through this same function: the user's
 * integrations per `global_assistant_config` (`enabledUserIntegrations`,
 * `driveOverrides`, `inheritDriveIntegrations`, connection visibility), plus
 * the drive-level ones of `driveInView` when the user is a member there
 * (`resolveIntegrationDriveScope`).
 *
 * @param params.userId - The authenticated user's ID
 * @param params.agentId - The Imago agent's page ID (recorded on audit
 *   entries), null for the Global Assistant
 * @param params.driveInView - The drive in view (null on the dashboard). An
 *   Imago caller passes null for a drive the user keeps Imago out of.
 * @param params.currentTools - The assistant's already-resolved tool set
 *   (before these integration tools are merged in), used to suppress GitHub
 *   OAuth integration tools when the sandbox git/gh CLI toolkit is already
 *   present. Pass the full pre-core/non-core-split filtered tool set — the
 *   assistant's final tool set never carries raw tool names as top-level keys
 *   (core tools + tool_search/execute_tool only).
 * @returns AI SDK tool objects ready for merging into the tool set
 */
export async function resolveAssistantIntegrationTools(params: {
  userId: string;
  agentId: string | null;
  driveInView: string | null;
  currentTools: Record<string, unknown>;
}): Promise<Record<string, CoreTool>> {
  const { userId, agentId, driveInView, currentTools } = params;
  // A drive the user is not a member of resolves no drive-scoped integrations.
  const { driveId, userDriveRole } = await resolveIntegrationDriveScope(userId, driveInView);
  const grants = await resolveGlobalAssistantIntegrations(
    createResolutionDeps(),
    userId,
    driveId,
    userDriveRole
  );

  return toSortedAISDKTools(grants, { userId, agentId, driveId }, currentTools);
}
