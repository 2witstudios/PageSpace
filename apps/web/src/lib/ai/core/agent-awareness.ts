/**
 * Agent Awareness Module
 *
 * Builds a system prompt section that lists available AI agents
 * for the global assistant to be aware of and consult via ask_agent.
 *
 * Uses per-drive caching to reduce database queries. Cache is invalidated
 * when agents are created, edited, or deleted.
 */

import { db, pages, drives, eq, and } from '@pagespace/db';
import { getUserDriveAccess, canUserViewPage, agentAwarenessCache } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import type { CachedAgent } from '@pagespace/lib/server';

interface VisibleAgent {
  id: string;
  title: string;
  definition: string | null;
  driveName: string;
}

/**
 * Query visible agents for a drive from the database
 * Returns agents that are:
 * - Type AI_CHAT
 * - Not trashed
 * - Visible to global assistant (not explicitly hidden)
 */
async function queryDriveAgents(driveId: string): Promise<CachedAgent[]> {
  const agents = await db
    .select({
      id: pages.id,
      title: pages.title,
      agentDefinition: pages.agentDefinition,
      visibleToGlobalAssistant: pages.visibleToGlobalAssistant,
    })
    .from(pages)
    .where(and(
      eq(pages.driveId, driveId),
      eq(pages.type, 'AI_CHAT'),
      eq(pages.isTrashed, false)
    ))
    .orderBy(pages.title);

  // Filter to only visible agents and map to CachedAgent format
  return agents
    .filter(agent => agent.visibleToGlobalAssistant !== false)
    .map(agent => ({
      id: agent.id,
      title: agent.title,
      definition: agent.agentDefinition,
    }));
}

/**
 * Builds the agent awareness section for the global assistant's system prompt.
 *
 * Returns a formatted markdown section listing all visible AI agents
 * that the user has access to across all their drives.
 *
 * Uses per-drive caching to minimize database queries:
 * - Cache key: driveId -> list of visible agents
 * - Cache hit: Skip DB query for that drive
 * - Cache miss: Query DB and populate cache
 * - Per-user permission filtering still applied (uses cached permissions)
 *
 * @param userId - The authenticated user's ID
 * @returns A formatted string to append to the system prompt, or empty string if no agents
 */
export async function buildAgentAwarenessPrompt(userId: string): Promise<string> {
  try {
    // Get all non-trashed drives
    const allDrives = await db
      .select({ id: drives.id, name: drives.name })
      .from(drives)
      .where(eq(drives.isTrashed, false));

    // Filter to drives the user has access to
    // Note: getUserDriveAccess uses cached permissions
    const accessibleDrives: Array<{ id: string; name: string }> = [];
    for (const drive of allDrives) {
      const hasAccess = await getUserDriveAccess(userId, drive.id);
      if (hasAccess) {
        accessibleDrives.push(drive);
      }
    }

    if (accessibleDrives.length === 0) {
      return '';
    }

    // Collect all visible agents using per-drive caching
    const visibleAgents: VisibleAgent[] = [];
    let cacheHits = 0;
    let cacheMisses = 0;

    for (const drive of accessibleDrives) {
      // Check cache first
      const cached = await agentAwarenessCache.getDriveAgents(drive.id);

      let driveAgents: CachedAgent[];

      if (cached) {
        // Cache hit - use cached agent list
        driveAgents = cached.agents;
        cacheHits++;
      } else {
        // Cache miss - query DB and populate cache
        driveAgents = await queryDriveAgents(drive.id);
        await agentAwarenessCache.setDriveAgents(drive.id, drive.name, driveAgents);
        cacheMisses++;
      }

      // Filter by user permissions (still needed per-user)
      // Note: canUserViewPage uses cached permissions
      for (const agent of driveAgents) {
        const canView = await canUserViewPage(userId, agent.id);
        if (canView) {
          visibleAgents.push({
            id: agent.id,
            title: agent.title,
            definition: agent.definition,
            driveName: drive.name,
          });
        }
      }
    }

    // If no visible agents, return empty string
    if (visibleAgents.length === 0) {
      return '';
    }

    // Build the formatted prompt section
    let prompt = '## Available AI Agents\n\n';
    prompt += 'You can consult these agents using `ask_agent`. If the user references an agent not listed here, use `list_agents` or `multi_drive_list_agents` to find it.\n\n';

    for (const agent of visibleAgents) {
      prompt += `- **${agent.title}** (ID: ${agent.id}) [${agent.driveName}]\n`;
      if (agent.definition) {
        prompt += `  ${agent.definition}\n`;
      }
      prompt += '\n';
    }

    loggers.ai.debug('Built agent awareness prompt', {
      userId,
      agentCount: visibleAgents.length,
      driveCount: accessibleDrives.length,
      cacheHits,
      cacheMisses,
    });

    return prompt.trim();

  } catch (error) {
    loggers.ai.error('Failed to build agent awareness prompt:', error as Error);
    // Return empty string on error - don't break the system prompt
    return '';
  }
}
