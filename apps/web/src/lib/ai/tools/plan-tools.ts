import { tool } from 'ai';
import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { and, eq, ne, desc } from '@pagespace/db/operators';
import { plans } from '@pagespace/db/schema/plans';
import type { Plan } from '@pagespace/db/schema/plans';
import { pages } from '@pagespace/db/schema/core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { maskIdentifier } from '@/lib/logging/mask';
import {
  canActorAccessDrive,
  canActorEditPage,
  canActorViewPage,
} from './actor-permissions';
import type { ToolExecutionContext } from '../core/types';

const planLogger = loggers.ai.child({ module: 'plan-tools' });

const LIST_PLANS_LIMIT = 50;

function planSummary(plan: Plan) {
  return {
    planId: plan.id,
    pageId: plan.pageId,
    driveId: plan.driveId,
    goal: plan.goal,
    status: plan.status,
    approvedAt: plan.approvedAt,
    updatedAt: plan.updatedAt,
  };
}

export const planTools = {
  create_plan: tool({
    description:
      "Register an existing DOCUMENT page as a structured plan. The page holds the plan's written content (goal, approach, steps, open questions); this registration gives it a durable, queryable status record (starting as 'draft') that other tools and later turns can look up via get_active_plan/list_plans. Create the plan page first with create_page, then register it here.",
    inputSchema: z.object({
      pageId: z
        .string()
        .describe('ID of the page holding the written plan content.'),
      goal: z
        .string()
        .min(1)
        .max(500)
        .describe(
          "One-line summary of what the plan achieves, shown by list/lookup tools without opening the page."
        ),
      driveId: z.string().describe("ID of the drive the plan page lives in."),
    }),
    execute: async ({ pageId, goal, driveId }, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext;
      const userId = ctx?.userId;
      if (!userId) throw new Error('User authentication required');

      const trimmedGoal = goal.trim();
      if (!trimmedGoal) throw new Error('Plan goal cannot be empty');

      try {
        const page = await db.query.pages.findFirst({
          where: eq(pages.id, pageId),
          columns: { id: true, driveId: true, isTrashed: true },
        });
        if (!page) throw new Error('Plan page not found');
        if (page.isTrashed) throw new Error('Plan page is in the trash');
        if (page.driveId !== driveId) {
          throw new Error('driveId does not match the drive the plan page lives in');
        }

        const canEdit = await canActorEditPage(ctx, pageId);
        if (!canEdit) throw new Error('You do not have edit access to the plan page');

        const existing = await db.query.plans.findFirst({
          where: eq(plans.pageId, pageId),
          columns: { id: true, status: true },
        });
        if (existing) {
          throw new Error(
            `This page is already registered as plan ${existing.id} (status: ${existing.status}). Use set_plan_status to update it.`
          );
        }

        const [created] = await db
          .insert(plans)
          .values({
            pageId,
            driveId,
            goal: trimmedGoal,
            status: 'draft',
            createdBy: userId,
          })
          .returning();

        return {
          success: true,
          ...planSummary(created),
          message: `Plan registered as draft. Present it to the user for approval, then call set_plan_status('approved').`,
        };
      } catch (error) {
        planLogger.error('Failed to create plan', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          pageId: maskIdentifier(pageId),
        });
        throw new Error(
          `Failed to create plan: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),

  get_active_plan: tool({
    description:
      "Look up the drive's current plan — the most relevant non-superseded plan (an approved plan wins over a draft; most recently updated as tiebreaker). Use this to resume work against a previously registered plan, e.g. in a later conversation or after earlier context is no longer available, instead of relying on conversation memory. Returns the plan's id, page id, goal, and status; read the page for the full plan content.",
    inputSchema: z.object({
      driveId: z.string().describe('ID of the drive to look up the active plan for.'),
    }),
    execute: async ({ driveId }, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext;
      const userId = ctx?.userId;
      if (!userId) throw new Error('User authentication required');

      try {
        const canAccess = await canActorAccessDrive(ctx, driveId);
        if (!canAccess) throw new Error('Drive not found or you do not have access to it');

        const candidates = await db
          .select()
          .from(plans)
          .where(and(eq(plans.driveId, driveId), ne(plans.status, 'superseded')))
          .orderBy(desc(plans.updatedAt))
          .limit(LIST_PLANS_LIMIT);

        // Approved beats draft; within a status, the most recently updated
        // (already sorted) wins. Skip plans whose page the actor cannot view.
        const ordered = [
          ...candidates.filter((plan) => plan.status === 'approved'),
          ...candidates.filter((plan) => plan.status !== 'approved'),
        ];
        for (const plan of ordered) {
          if (await canActorViewPage(ctx, plan.pageId)) {
            return { found: true, ...planSummary(plan) };
          }
        }

        return {
          found: false,
          message: 'No active plan is registered for this drive.',
        };
      } catch (error) {
        planLogger.error('Failed to get active plan', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          driveId: maskIdentifier(driveId),
        });
        throw new Error(
          `Failed to get active plan: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),

  set_plan_status: tool({
    description:
      "Transition a plan's status: 'approved' marks a draft plan as approved by the user (records who approved it and when); 'superseded' retires a plan from any status, e.g. when it is replaced by a newer plan. Plans start as 'draft' — keep iterating on the plan page while in draft. Use list_plans or get_active_plan to find plan IDs.",
    inputSchema: z.object({
      planId: z.string().describe('ID of the plan to transition.'),
      status: z
        .enum(['approved', 'superseded'])
        .describe(
          "New status. 'approved' is only valid from 'draft'; 'superseded' is valid from any status."
        ),
    }),
    execute: async ({ planId, status }, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext;
      const userId = ctx?.userId;
      if (!userId) throw new Error('User authentication required');

      try {
        const plan = await db.query.plans.findFirst({ where: eq(plans.id, planId) });
        if (!plan) throw new Error('Plan not found');

        const canEdit = await canActorEditPage(ctx, plan.pageId);
        if (!canEdit) throw new Error('You do not have edit access to the plan page');

        if (plan.status === status) {
          return {
            success: true,
            ...planSummary(plan),
            message: `Plan is already ${status}.`,
          };
        }
        if (status === 'approved' && plan.status !== 'draft') {
          throw new Error(
            `Only a draft plan can be approved (current status: ${plan.status}). Create a new plan instead.`
          );
        }

        const [updated] = await db
          .update(plans)
          .set(
            status === 'approved'
              ? { status, approvedBy: userId, approvedAt: new Date() }
              : { status }
          )
          .where(eq(plans.id, plan.id))
          .returning();

        return {
          success: true,
          ...planSummary(updated),
          message: `Plan marked ${status}.`,
        };
      } catch (error) {
        planLogger.error('Failed to set plan status', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          planId: maskIdentifier(planId),
        });
        throw new Error(
          `Failed to set plan status: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),

  list_plans: tool({
    description:
      'List registered plans in a drive, newest first, optionally filtered by status (draft, approved, or superseded). Returns each plan\'s id, page id, goal, and status.',
    inputSchema: z.object({
      driveId: z.string().describe('ID of the drive to list plans for.'),
      status: z
        .enum(['draft', 'approved', 'superseded'])
        .optional()
        .describe('Filter to a single status. Omit to list plans of every status.'),
    }),
    execute: async ({ driveId, status }, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext;
      const userId = ctx?.userId;
      if (!userId) throw new Error('User authentication required');

      try {
        const canAccess = await canActorAccessDrive(ctx, driveId);
        if (!canAccess) throw new Error('Drive not found or you do not have access to it');

        const rows = await db
          .select()
          .from(plans)
          .where(
            status
              ? and(eq(plans.driveId, driveId), eq(plans.status, status))
              : eq(plans.driveId, driveId)
          )
          .orderBy(desc(plans.updatedAt))
          .limit(LIST_PLANS_LIMIT);

        const visible = [];
        for (const plan of rows) {
          if (await canActorViewPage(ctx, plan.pageId)) visible.push(planSummary(plan));
        }

        return { plans: visible, total: visible.length };
      } catch (error) {
        planLogger.error('Failed to list plans', error instanceof Error ? error : undefined, {
          userId: maskIdentifier(userId),
          driveId: maskIdentifier(driveId),
        });
        throw new Error(
          `Failed to list plans: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  }),
};
