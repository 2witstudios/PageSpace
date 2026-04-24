/**
 * Agent Awareness Module
 *
 * Builds a system prompt section that lists available AI agents
 * for the global assistant to be aware of and consult via ask_agent.
 */

import { db, pages, drives, eq, and } from '@pagespace/db';
import { getUserDriveAccess, canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';

interface DriveAgent {
  id: string;
  title: string;
  definition: string | null;
}

interface VisibleAgent {
  id: string;
  title: string;
  definition: string | null;
  driveName: string;
}

async function queryDriveAgents(driveId: string): Promise<DriveAgent[]> {
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
 * @param userId - The authenticated user's ID
 * @returns A formatted string to append to the system prompt, or empty string if no agents
 */
export async function buildAgentAwarenessPrompt(userId: string): Promise<string> {
  try {
    const allDrives = await db
      .select({ id: drives.id, name: drives.name })
      .from(drives)
      .where(eq(drives.isTrashed, false));

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

    const visibleAgents: VisibleAgent[] = [];

    for (const drive of accessibleDrives) {
      const driveAgents = await queryDriveAgents(drive.id);

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

    if (visibleAgents.length === 0) {
      return '';
    }

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
    return '';
  }
}
