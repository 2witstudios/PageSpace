/**
 * Integration Tool Resolver
 *
 * Shared helper used by both the page agent chat route and the global assistant route
 * to resolve and convert integration tools into AI SDK format.
 */

import { db } from '@pagespace/db/db';
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
import {
  createToolExecutor,
  type ExecuteToolDependencies,
} from '@pagespace/lib/integrations/saga/execute-tool';
import {
  getConnectionWithProvider,
  listUserConnections,
  listDriveConnections,
} from '@pagespace/lib/integrations/repositories/connection-repository';
import { logAuditEntry } from '@pagespace/lib/integrations/repositories/audit-repository';
import { listGrantsByAgent } from '@pagespace/lib/integrations/repositories/grant-repository';
import { getConfig } from '@pagespace/lib/integrations/repositories/config-repository';
import { type DriveRole, type GlobalAssistantConfigData } from '@pagespace/lib/integrations/types';
import { suppressGithubIntegrationTools } from './tool-filtering';

/** The connection type expected by the tool executor's loadConnection dependency. */
type LoadConnectionResult = ExecuteToolDependencies['loadConnection'] extends
  (id: string) => Promise<infer R> ? R : never;

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
 * Create a configured tool executor wired to database dependencies.
 */
function createConfiguredExecutor(userId: string, agentId: string | null, driveId: string | null) {
  return createToolExecutor({
    loadConnection: (connectionId) =>
      getConnectionWithProvider(db, connectionId) as Promise<LoadConnectionResult>,
    logAudit: async (entry) => {
      await logAuditEntry(db, {
        driveId: entry.driveId ?? driveId,
        agentId,
        userId,
        connectionId: entry.connectionId,
        toolName: entry.toolName,
        success: entry.success,
        errorType: entry.errorType,
        errorMessage: entry.errorMessage,
        responseCode: entry.responseCode,
        durationMs: entry.durationMs,
      });
    },
  });
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

  if (grants.length === 0) return {};

  const executor = createConfiguredExecutor(userId, agentId, driveId);

  const tools = suppressGithubIntegrationTools(
    convertIntegrationToolsToAISDK(grants, { userId, agentId, driveId }, executor),
    currentTools
  );
  // Sort keys so tool array order is deterministic across requests (only real config
  // changes — webSearch/readOnly/MCP/exposure-mode — may change the tool array).
  return Object.fromEntries(Object.keys(tools).sort().map(k => [k, tools[k]]));
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

  if (grants.length === 0) return {};

  const executor = createConfiguredExecutor(userId, null, driveId);

  const tools = suppressGithubIntegrationTools(
    convertIntegrationToolsToAISDK(grants, { userId, agentId: null, driveId }, executor),
    currentTools
  );
  // Sort keys so tool array order is deterministic across requests (only real config
  // changes — webSearch/readOnly/MCP/exposure-mode — may change the tool array).
  return Object.fromEntries(Object.keys(tools).sort().map(k => [k, tools[k]]));
}
