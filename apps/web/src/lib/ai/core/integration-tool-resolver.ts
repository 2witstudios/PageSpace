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
 * Resolve integration tools for a page agent (AI_CHAT page with grants).
 *
 * @param params.agentId - The page ID of the AI_CHAT agent
 * @param params.userId - The authenticated user's ID
 * @param params.driveId - The drive containing the agent
 * @param params.currentTools - The agent's already-resolved tool set (before
 *   these integration tools are merged in), used to suppress GitHub OAuth
 *   integration tools when the sandbox git/gh CLI toolkit is already present.
 *   Callers must pass the pre-tool-exposure-mode set — search mode defers
 *   non-core tools behind execute_tool, hiding their names from a key scan.
 * @returns AI SDK tool objects ready for merging into the tool set
 */
export async function resolvePageAgentIntegrationTools(params: {
  agentId: string;
  userId: string;
  driveId: string;
  currentTools: Record<string, unknown>;
}): Promise<Record<string, CoreTool>> {
  const { agentId, userId, driveId, currentTools } = params;
  const deps = createResolutionDeps();

  const grants = await resolveAgentIntegrations(deps, agentId);

  return toSortedAISDKTools(grants, { userId, agentId, driveId }, currentTools);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL ASSISTANT RESOLVER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve integration tools for the global assistant.
 *
 * @param params.userId - The authenticated user's ID
 * @param params.driveId - The current drive context (null when in dashboard)
 * @param params.userDriveRole - The user's role in the current drive
 * @param params.currentTools - The assistant's already-resolved tool set
 *   (before these integration tools are merged in), used to suppress GitHub
 *   OAuth integration tools when the sandbox git/gh CLI toolkit is already
 *   present. Pass the full pre-core/non-core-split filtered tool set — the
 *   Global Assistant's final tool set never carries raw tool names as
 *   top-level keys (core tools + tool_search/execute_tool only).
 * @returns AI SDK tool objects ready for merging into the tool set
 */
export async function resolveGlobalAssistantIntegrationTools(params: {
  userId: string;
  driveId: string | null;
  userDriveRole: DriveRole | null;
  currentTools: Record<string, unknown>;
}): Promise<Record<string, CoreTool>> {
  const { userId, driveId, userDriveRole, currentTools } = params;
  const deps = createResolutionDeps();

  const grants = await resolveGlobalAssistantIntegrations(
    deps,
    userId,
    driveId,
    userDriveRole
  );

  return toSortedAISDKTools(grants, { userId, agentId: null, driveId }, currentTools);
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMAGO AGENT RESOLVER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve integration tools for a built-in Imago agent (IMG-4.8).
 *
 * An Imago agent is the user's assistant, so it gets what the Global Assistant
 * resolves — the user's integrations per `global_assistant_config`
 * (`enabledUserIntegrations`, `driveOverrides`, `inheritDriveIntegrations`,
 * connection visibility) — with one difference in reach: drive-level
 * integrations come only from `grantedDriveId`, which the caller must pass
 * only for the Home drive or a drive the agent holds a `drive_agent_members`
 * grant on (see `resolveImagoIntegrationDriveId`). A drive in view without a
 * grant contributes nothing; user-level integrations are resolved as on the
 * dashboard.
 *
 * Onprem exposes no external integration at all.
 *
 * @param params.agentId - The Imago agent's page ID (recorded on audit entries)
 * @param params.userId - The authenticated user's ID
 * @param params.grantedDriveId - The drive in view, when the agent may work in it
 * @param params.currentTools - The pre-exposure-mode tool set (see
 *   `resolvePageAgentIntegrationTools`)
 */
export async function resolveImagoAgentIntegrationTools(params: {
  agentId: string;
  userId: string;
  grantedDriveId: string | null;
  currentTools: Record<string, unknown>;
}): Promise<Record<string, CoreTool>> {
  const { agentId, userId, grantedDriveId, currentTools } = params;
  if (isOnPrem()) return {};

  const { driveId, userDriveRole } = await resolveIntegrationDriveScope(userId, grantedDriveId);
  const grants = await resolveGlobalAssistantIntegrations(
    createResolutionDeps(),
    userId,
    driveId,
    userDriveRole
  );

  return toSortedAISDKTools(grants, { userId, agentId, driveId }, currentTools);
}
