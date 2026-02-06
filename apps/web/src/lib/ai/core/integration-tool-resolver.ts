/**
 * Integration Tool Resolver
 *
 * Shared helper used by both the page agent chat route and the global assistant route
 * to resolve and convert integration tools into AI SDK format.
 */

import { db } from '@pagespace/db';
import {
  resolveAgentIntegrations,
  resolveGlobalAssistantIntegrations,
  convertIntegrationToolsToAISDK,
  createToolExecutor,
  getConnectionWithProvider,
  logAuditEntry,
  listGrantsByAgent,
  listUserConnections,
  listDriveConnections,
  getConfig,
  type CoreTool,
  type DriveRole,
  type ResolutionDependencies,
  type ExecuteToolDependencies,
  type GrantWithConnectionAndProvider,
  type GlobalAssistantConfigData,
} from '@pagespace/lib/integrations';

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
function createConfiguredExecutor(userId: string, agentId: string, driveId: string) {
  return createToolExecutor({
    loadConnection: (connectionId) =>
      getConnectionWithProvider(db, connectionId) as Promise<LoadConnectionResult>,
    logAudit: async (entry) => {
      await logAuditEntry(db, {
        driveId,
        agentId,
        userId,
        connectionId: '', // Will be filled by the saga
        toolName: '',     // Will be filled by the saga
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
 * @returns AI SDK tool objects ready for merging into the tool set
 */
export async function resolvePageAgentIntegrationTools(params: {
  agentId: string;
  userId: string;
  driveId: string;
}): Promise<Record<string, CoreTool>> {
  const { agentId, userId, driveId } = params;
  const deps = createResolutionDeps();

  const grants = await resolveAgentIntegrations(deps, agentId);

  if (grants.length === 0) return {};

  const executor = createConfiguredExecutor(userId, agentId, driveId);

  return convertIntegrationToolsToAISDK(
    grants,
    { userId, agentId, driveId },
    executor
  );
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
 * @returns AI SDK tool objects ready for merging into the tool set
 */
export async function resolveGlobalAssistantIntegrationTools(params: {
  userId: string;
  driveId: string | null;
  userDriveRole: DriveRole | null;
}): Promise<Record<string, CoreTool>> {
  const { userId, driveId, userDriveRole } = params;
  const deps = createResolutionDeps();

  const grants = await resolveGlobalAssistantIntegrations(
    deps,
    userId,
    driveId,
    userDriveRole
  );

  if (grants.length === 0) return {};

  const executor = createConfiguredExecutor(userId, 'global-assistant', driveId || 'dashboard');

  return convertIntegrationToolsToAISDK(
    grants,
    { userId, agentId: 'global-assistant', driveId: driveId || 'dashboard' },
    executor
  );
}
