/**
 * Agent Awareness Module
 *
 * Builds a system prompt section that lists available AI agents
 * for the global assistant to be aware of and consult via ask_agent.
 */

import { db, pages, drives, eq, and } from '@pagespace/db';
import { getUserDriveAccess, canUserViewPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';

interface VisibleAgent {
  id: string;
  title: string;
  definition: string | null;
  driveName: string;
}

/**
 * Builds the agent awareness section for the global assistant's system prompt.
 *
 * Returns a formatted markdown section listing all visible AI agents
 * that the user has access to across all their drives.
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

    // Collect all visible agents
    const visibleAgents: VisibleAgent[] = [];

    for (const drive of accessibleDrives) {
      // Query AI_CHAT pages that are visible to global assistant
      const agents = await db
        .select({
          id: pages.id,
          title: pages.title,
          agentDefinition: pages.agentDefinition,
          visibleToGlobalAssistant: pages.visibleToGlobalAssistant,
        })
        .from(pages)
        .where(and(
          eq(pages.driveId, drive.id),
          eq(pages.type, 'AI_CHAT'),
          eq(pages.isTrashed, false)
        ))
        .orderBy(pages.title);

      // Filter by visibility flag and user permissions
      for (const agent of agents) {
        // Skip if explicitly hidden from global assistant
        if (agent.visibleToGlobalAssistant === false) {
          continue;
        }

        // Check user can view this agent
        const canView = await canUserViewPage(userId, agent.id);
        if (canView) {
          visibleAgents.push({
            id: agent.id,
            title: agent.title,
            definition: agent.agentDefinition,
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
    });

    return prompt.trim();

  } catch (error) {
    loggers.ai.error('Failed to build agent awareness prompt:', error as Error);
    // Return empty string on error - don't break the system prompt
    return '';
  }
}
