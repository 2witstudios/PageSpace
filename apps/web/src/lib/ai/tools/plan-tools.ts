/**
 * set_plan / clear_plan — bind this conversation to the DOCUMENT page holding
 * the plan it is working against.
 *
 * Why a persisted binding rather than "the agent remembers": compaction is
 * lossy. The summary at ModelMessages[0] only *mostly* remembers a plan, while
 * a re-read of the page is exact — which is why every comparable harness makes
 * the plan a durable artifact and re-reads it after a summary. A pointer
 * carried in the message stream would be compacted away with everything else
 * (exactly how TasksDropdown's message-derived task binding empties on
 * truncation), so this one lives on `conversations.planPageId` and is rendered
 * into the CACHE-STABLE system prompt, which is never compacted.
 *
 * Deliberately NOT in WRITE_TOOLS: these mutate conversation metadata, not user
 * content, and binding an EXISTING plan doc is a legitimate read-only-mode
 * action (read-only is framed as plan mode — see READ_ONLY_CONSTRAINT).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { pages } from '@pagespace/db/schema/core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { canActorViewPage } from './actor-permissions';
import type { ToolExecutionContext } from '../core/types';

const planLogger = loggers.ai.child({ module: 'plan-tools' });

/**
 * Only a real, persisted conversation can hold a binding. Workflow runs
 * synthesize an ephemeral id (`workflow-<id>-<ts>`, see workflow-executor) that
 * has no row, so the UPDATE would silently match nothing — say so instead of
 * reporting a success that didn't happen.
 */
async function loadOwnedConversation(conversationId: string, userId: string) {
  const [row] = await db
    .select({ id: conversations.id, userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row && row.userId === userId ? row : null;
}

export const planTools = {
  set_plan: tool({
    description:
      'Bind this conversation to the DOCUMENT page holding its plan. Call this immediately after creating or locating a plan page. ' +
      'The binding persists and survives context summarization, so you can always find your way back to the authoritative plan — ' +
      're-read it with read_page after a summary or a long gap instead of trusting your recollection.',
    inputSchema: z
      .object({
        pageId: z
          .string()
          .min(1)
          .describe('The plan page id — a real id from create_page/read_page/list_pages, never a guess.'),
      })
      .strict(),
    execute: async ({ pageId }, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext | undefined;
      if (!ctx?.userId) return { success: false, error: 'No authenticated user in this context.' };
      const { userId, conversationId } = ctx;
      if (!conversationId) {
        return {
          success: false,
          error: 'This context has no conversation to bind a plan to. The plan page still exists — tell the user where it is.',
        };
      }

      try {
        const [page] = await db
          .select({ id: pages.id, title: pages.title, type: pages.type, isTrashed: pages.isTrashed })
          .from(pages)
          .where(eq(pages.id, pageId))
          .limit(1);

        // A page the caller cannot see must be indistinguishable from one that
        // does not exist — same contract as the command resolver.
        //
        // canActorViewPage, not canUserViewPage: this tool also runs under a
        // scoped MCP token or a page-agent, and binding a plan the ACTOR cannot
        // reach would smuggle that page's title back through the ACTIVE PLAN
        // prompt section on every later turn.
        if (!page || page.isTrashed || !(await canActorViewPage(ctx, pageId))) {
          return { success: false, error: `No page found with id "${pageId}".` };
        }
        if (page.type !== 'DOCUMENT') {
          return {
            success: false,
            error: `A plan must be a DOCUMENT page, but "${page.title}" is a ${page.type}. Task lists are produced by the task skill and are bound separately.`,
          };
        }

        const conversation = await loadOwnedConversation(conversationId, userId);
        if (!conversation) {
          return {
            success: false,
            error: 'This conversation cannot hold a plan binding. The plan page still exists — tell the user where it is.',
          };
        }

        await db
          .update(conversations)
          .set({ planPageId: pageId, updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));

        planLogger.info('plan bound to conversation', { conversationId, pageId });

        return {
          success: true,
          pageId,
          title: page.title,
          message: `This conversation is now working against the plan "${page.title}".`,
          nextSteps: [
            'Tell the user where the plan lives so they can open and edit it.',
            'Re-read this page with read_page after a context summary or a long gap — it is authoritative, your recollection is not.',
          ],
        };
      } catch (error) {
        planLogger.error('set_plan failed', error as Error, { conversationId, pageId });
        return { success: false, error: 'Failed to bind the plan to this conversation.' };
      }
    },
  }),

  clear_plan: tool({
    description:
      'Unbind this conversation from its plan page. Use when the plan is finished or abandoned. The page itself is not deleted.',
    inputSchema: z.object({}).strict(),
    execute: async (_input, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext | undefined;
      const userId = ctx?.userId;
      const conversationId = ctx?.conversationId;
      if (!userId) return { success: false, error: 'No authenticated user in this context.' };
      if (!conversationId) return { success: false, error: 'This context has no conversation.' };

      try {
        const conversation = await loadOwnedConversation(conversationId, userId);
        if (!conversation) return { success: false, error: 'This conversation cannot hold a plan binding.' };

        await db
          .update(conversations)
          .set({ planPageId: null, updatedAt: new Date() })
          .where(eq(conversations.id, conversationId));

        planLogger.info('plan unbound from conversation', { conversationId });

        return { success: true, message: 'This conversation is no longer bound to a plan.' };
      } catch (error) {
        planLogger.error('clear_plan failed', error as Error, { conversationId });
        return { success: false, error: 'Failed to unbind the plan from this conversation.' };
      }
    },
  }),
};
