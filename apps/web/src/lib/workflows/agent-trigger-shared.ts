import { z } from 'zod';
import type { db as DbType } from '@pagespace/db/db';
import { eq, and, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';

/**
 * The agent-trigger payload shared by every surface that can schedule an AI
 * agent to run later — task triggers, calendar triggers, and standalone cron
 * workflows. It answers "who runs, and with what context"; the "when" is
 * domain-specific and lives with each surface (task due_date/completion,
 * calendar event time, cron expression).
 *
 * Previously this shape was copy-pasted as AgentTriggerInput (tasks) and
 * CalendarAgentTriggerInput (calendar). Keep it here so the three surfaces can
 * never drift on what an agent trigger accepts.
 */

export const MAX_CONTEXT_PAGES = 10;

/**
 * Zod schema for the shared payload. Task triggers extend this with a
 * `triggerType` field; calendar and cron use it as-is.
 */
export const agentTriggerBaseSchema = z.object({
  agentPageId: z.string().describe('ID of the AI agent (AI_CHAT) page to execute'),
  prompt: z.string().max(10000).optional().describe('Instructions for the agent when it runs'),
  instructionPageId: z.string().nullable().optional().describe('Page ID containing detailed instructions'),
  contextPageIds: z
    .array(z.string())
    .max(MAX_CONTEXT_PAGES)
    .optional()
    .describe('Page IDs to include as reference context'),
});

export type AgentTriggerPayload = z.infer<typeof agentTriggerBaseSchema>;

export interface ValidateAgentTriggerParams {
  driveId: string;
  agentTrigger: AgentTriggerPayload;
  /**
   * Names the host entity in error messages, e.g. "task list" or "event", so
   * the rejection reads naturally for the surface the user is on.
   */
  entityLabel: string;
}

/**
 * Pre-write validation shared by task, calendar, and cron trigger creation:
 *  - at least a prompt or an instruction page is provided,
 *  - the context list is within MAX_CONTEXT_PAGES,
 *  - the agent is an AI_CHAT page in the same drive and not trashed,
 *  - the instruction and context pages all live in the same drive and aren't trashed.
 *
 * Returns the validated agent page id. Throws with a human-readable message on
 * the first failure.
 */
export async function validateAgentTrigger(
  database: typeof DbType,
  params: ValidateAgentTriggerParams,
): Promise<{ agentPageId: string }> {
  const { driveId, agentTrigger, entityLabel } = params;
  const promptText = agentTrigger.prompt?.trim() ?? '';

  if (!promptText && !agentTrigger.instructionPageId) {
    throw new Error('Agent trigger needs either a prompt or instructionPageId');
  }

  const contextPageIds = agentTrigger.contextPageIds ?? [];
  if (contextPageIds.length > MAX_CONTEXT_PAGES) {
    throw new Error(`Agent trigger accepts at most ${MAX_CONTEXT_PAGES} context pages`);
  }

  const agent = await database.query.pages.findFirst({
    where: and(eq(pages.id, agentTrigger.agentPageId), eq(pages.type, 'AI_CHAT'), eq(pages.isTrashed, false)),
    columns: { id: true, driveId: true },
  });
  if (!agent) throw new Error('Agent page not found or not an AI agent');
  if (agent.driveId !== driveId) throw new Error(`Agent must be in the same drive as the ${entityLabel}`);

  if (agentTrigger.instructionPageId) {
    const instrPage = await database.query.pages.findFirst({
      where: and(eq(pages.id, agentTrigger.instructionPageId), eq(pages.driveId, driveId), eq(pages.isTrashed, false)),
      columns: { id: true },
    });
    if (!instrPage) throw new Error('Instruction page not found or not in the same drive');
  }

  if (contextPageIds.length > 0) {
    // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
    const validPages = await database.query.pages.findMany({
      where: and(
        inArray(pages.id, contextPageIds),
        eq(pages.driveId, driveId),
        eq(pages.isTrashed, false),
      ),
      columns: { id: true },
    });
    if (validPages.length !== contextPageIds.length) {
      throw new Error('Some context pages were not found or are not in the same drive');
    }
  }

  return { agentPageId: agent.id };
}
