/**
 * Agent Awareness Module
 *
 * Builds a system prompt section that lists available AI agents
 * for the global assistant to be aware of and consult via ask_agent.
 */

import { db } from '@pagespace/db/db'
import { eq, and } from '@pagespace/db/operators'
import { pages, drives } from '@pagespace/db/schema/core';
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
 * @param options.canDelegate - Whether `spawn_session` is actually IN the caller's
 *   tool set. The chat-only session family registers regardless of the
 *   CODE_EXECUTION kill-switch, but read-only mode strips `spawn_session` as a
 *   write tool — and an unconditional "delegate with spawn_session" instruction
 *   told the model to call a tool it does not have: it would confidently attempt
 *   delegation and silently fail. Defaults to false: a prompt that never mentions
 *   a tool is always safe, one that mentions a missing tool never is.
 * @returns A formatted string to append to the system prompt, or empty string if no agents
 */
export async function buildAgentAwarenessPrompt(
  userId: string,
  options: { canDelegate?: boolean } = {},
): Promise<string> {
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
    prompt += options.canDelegate
      ? 'You can delegate to these agents with `spawn_session` (pass their ID as `agent`; `wait: true` for a synchronous answer). If the user references an agent not listed here, use `list_agents` or `multi_drive_list_agents` to find it.\n\n'
      : 'These agents exist in the workspace. If the user references an agent not listed here, use `list_agents` or `multi_drive_list_agents` to find it.\n\n';

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
