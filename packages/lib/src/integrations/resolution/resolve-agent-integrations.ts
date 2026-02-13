/**
 * Agent Integration Resolution
 *
 * Resolves which integration connections and grants an agent can access.
 * Handles both page-level agents (via grants) and the global assistant
 * (via user connections + drive connections + config).
 */

import type { DriveRole, GlobalAssistantConfigData } from '../types';
import type { GrantWithConnectionAndProvider } from '../converter/ai-sdk';
import { isUserIntegrationVisibleInDrive } from '../validation/visibility';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dependencies injected for testability.
 * All DB access goes through these functions.
 */
export interface ResolutionDependencies {
  listGrantsByAgent: (agentId: string) => Promise<GrantWithConnectionAndProvider[]>;
  listUserConnections: (userId: string) => Promise<ConnectionWithProviderForResolution[]>;
  listDriveConnections: (driveId: string) => Promise<ConnectionWithProviderForResolution[]>;
  getAssistantConfig: (userId: string) => Promise<GlobalAssistantConfigData | null>;
}

export interface ConnectionWithProviderForResolution {
  id: string;
  name: string;
  status: string;
  providerId: string;
  visibility: 'private' | 'owned_drives' | 'all_drives' | null;
  provider: {
    id: string;
    slug: string;
    name: string;
    config: unknown;
  } | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE AGENT RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve integration tools for a page agent (AI_CHAT page).
 * Simply loads grants for the agent and filters by active connection.
 */
export async function resolveAgentIntegrations(
  deps: ResolutionDependencies,
  agentId: string
): Promise<GrantWithConnectionAndProvider[]> {
  const grants = await deps.listGrantsByAgent(agentId);

  return grants.filter((grant) => {
    if (!grant.connection) return false;
    if (grant.connection.status !== 'active') return false;
    if (!grant.connection.provider?.config) return false;
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL ASSISTANT RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve integration tools for the global assistant.
 *
 * Merges user connections + drive connections based on:
 * - User's global assistant config (enabledUserIntegrations, driveOverrides)
 * - Connection visibility settings
 * - Drive membership role
 *
 * Returns synthetic "grants" with full access (allowedTools: null)
 * since the global assistant doesn't use per-tool grants.
 */
export async function resolveGlobalAssistantIntegrations(
  deps: ResolutionDependencies,
  userId: string,
  driveId: string | null,
  userDriveRole: DriveRole | null
): Promise<GrantWithConnectionAndProvider[]> {
  const config = await deps.getAssistantConfig(userId);

  const enabledUserIntegrations = (config?.enabledUserIntegrations as string[] | null) ?? null;
  const driveOverrides = (config?.driveOverrides as Record<string, { enabled: boolean; enabledIntegrations?: string[] }>) ?? {};
  const inheritDriveIntegrations = config?.inheritDriveIntegrations ?? true;

  const grants: GrantWithConnectionAndProvider[] = [];

  // 1. Load user connections
  const userConnections = await deps.listUserConnections(userId);

  for (const conn of userConnections) {
    if (conn.status !== 'active') continue;
    if (!conn.provider?.config) continue;

    // Check visibility in current drive context
    if (driveId && conn.visibility) {
      if (!isUserIntegrationVisibleInDrive(conn.visibility, userDriveRole)) {
        continue;
      }
    }

    // Check enabledUserIntegrations filter
    if (enabledUserIntegrations !== null) {
      if (!enabledUserIntegrations.includes(conn.id)) {
        continue;
      }
    }

    grants.push(connectionToSyntheticGrant(conn, 'global-assistant'));
  }

  // 2. Load drive connections (if in drive context and inheritance is enabled)
  if (driveId && inheritDriveIntegrations) {
    // Check drive overrides
    const driveOverride = driveOverrides[driveId];
    if (driveOverride && !driveOverride.enabled) {
      // Drive integrations disabled for this drive
      return grants;
    }

    const driveConnections = await deps.listDriveConnections(driveId);

    for (const conn of driveConnections) {
      if (conn.status !== 'active') continue;
      if (!conn.provider?.config) continue;

      // Apply drive-specific integration filter
      if (driveOverride?.enabledIntegrations) {
        if (!driveOverride.enabledIntegrations.includes(conn.id)) {
          continue;
        }
      }

      // Avoid duplicates (same provider already added from user connections)
      const alreadyAdded = grants.some(
        (g) => g.connection?.providerId === conn.providerId
      );
      if (alreadyAdded) continue;

      grants.push(connectionToSyntheticGrant(conn, 'global-assistant'));
    }
  }

  return grants;
}

/**
 * Convert a connection to a synthetic grant for the global assistant.
 * Global assistant gets full access (no tool restrictions).
 */
function connectionToSyntheticGrant(
  conn: ConnectionWithProviderForResolution,
  agentId: string
): GrantWithConnectionAndProvider {
  return {
    id: `synthetic-${conn.id}`,
    agentId,
    connectionId: conn.id,
    allowedTools: null,
    deniedTools: null,
    readOnly: false,
    rateLimitOverride: null,
    connection: {
      id: conn.id,
      name: conn.name,
      status: conn.status,
      providerId: conn.providerId,
      provider: conn.provider as GrantWithConnectionAndProvider['connection'] extends null ? never : NonNullable<GrantWithConnectionAndProvider['connection']>['provider'],
    },
  };
}
