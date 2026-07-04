/**
 * Scheduled workflow operations (Phase 3 task 8).
 *
 * Route-verified against `apps/web/src/app/api/workflows/route.ts` (GET/POST)
 * and `apps/web/src/app/api/workflows/[workflowId]/route.ts` (GET/PATCH/DELETE)
 * (docs/sdk/operations-inventory.md §2.14, parity with MCP tools
 * `list_workflows`, `create_workflow`, `update_workflow`, `delete_workflow`).
 * The route also exposes a single-workflow GET, which was never a registered
 * MCP tool (inventory: "unexposed") — out of scope here, matching the old
 * tool surface exactly.
 *
 * DISCREPANCY vs the Phase 0 inventory's D7 row: D7 recorded the create/
 * update route schemas as `.strict()` with `prompt` required and no
 * `instructionPageId`. Re-reading the CURRENT route source shows fix #1768
 * landed since: both schemas now accept `instructionPageId` (nullable,
 * optional) alongside `prompt`, with a `.refine()` requiring at least one.
 * These operations mirror that current, fixed contract — not the stale D7
 * resolution.
 *
 * Every operation here (including `list`/GET) is gated on
 * `isPrincipalDriveOwnerOrAdmin` — unlike most list/read operations
 * elsewhere in this SDK, plain drive membership is not enough to even list
 * a drive's workflows. All four therefore declare `requiredScope: 'drive:admin'`.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

/** `EventTrigger` (`packages/db/src/schema/workflows.ts`) — only populated on event-triggered backing workflows, never on the cron rows this surface manages, but the column is part of the row shape either way. */
const eventTriggerSchema = z.object({
  operation: z.string(),
  resourceType: z.string(),
});

/**
 * Bare `workflows` table row (`packages/db/src/schema/workflows.ts`),
 * route-serialized (Date fields -> ISO string over JSON). Shared by
 * create/update (returned as-is) and list (extended below with `lastRun`).
 */
const workflowRowSchema = z.object({
  id: z.string(),
  driveId: z.string(),
  createdBy: z.string(),
  name: z.string(),
  agentPageId: z.string(),
  prompt: z.string(),
  contextPageIds: z.array(z.string()).nullable(),
  cronExpression: z.string().nullable(),
  timezone: z.string(),
  triggerType: z.enum(['cron', 'event']),
  eventTriggers: z.array(eventTriggerSchema).nullable(),
  watchedFolderIds: z.array(z.string()).nullable(),
  eventDebounceSecs: z.number().nullable(),
  instructionPageId: z.string().nullable(),
  isEnabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Single-row LATERAL projection from `workflow_runs` (`workflows/route.ts` GET), null when the workflow has never fired. */
const workflowRunSummarySchema = z.object({
  status: z.enum(['running', 'success', 'error', 'cancelled']),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().nullable(),
});

const workflowListItemSchema = workflowRowSchema.extend({
  lastRun: workflowRunSummarySchema.nullable(),
});

export const listWorkflows = defineOperation({
  name: 'workflows.list',
  method: 'GET',
  path: '/api/workflows',
  inputSchema: z.object({ driveId: z.string().min(1) }).strict(),
  outputSchema: z.array(workflowListItemSchema),
  requiredScope: 'drive:admin',
  description:
    "List a drive's cron-scheduled workflows, each with a summary of its most recent run. Requires drive owner or admin authority — plain membership is not enough.",
});

export const createWorkflow = defineOperation({
  name: 'workflows.create',
  method: 'POST',
  path: '/api/workflows',
  inputSchema: z
    .object({
      driveId: z.string().min(1),
      name: z.string().min(1).max(200),
      agentPageId: z.string().min(1),
      prompt: z.string().min(1).optional(),
      instructionPageId: z.string().nullable().optional(),
      contextPageIds: z.array(z.string()).default([]),
      cronExpression: z.string().min(1),
      timezone: z.string().default('UTC'),
      isEnabled: z.boolean().default(true),
    })
    .strict()
    .refine((data) => Boolean(data.prompt?.trim()) || Boolean(data.instructionPageId), {
      message: 'Either prompt or instructionPageId is required',
    }),
  outputSchema: workflowRowSchema,
  requiredScope: 'drive:admin',
  description:
    'Create a cron-scheduled workflow that runs an AI agent on a schedule. The agent page must be an AI_CHAT page in the same drive; provide a prompt, an instructionPageId, or both. Requires drive owner or admin authority.',
});

export const updateWorkflow = defineOperation({
  name: 'workflows.update',
  method: 'PATCH',
  path: '/api/workflows/:workflowId',
  inputSchema: z
    .object({
      workflowId: z.string(),
      name: z.string().min(1).max(200).optional(),
      agentPageId: z.string().min(1).optional(),
      prompt: z.string().min(1).optional(),
      instructionPageId: z.string().nullable().optional(),
      contextPageIds: z.array(z.string()).optional(),
      cronExpression: z.string().min(1).nullable().optional(),
      timezone: z.string().optional(),
      isEnabled: z.boolean().optional(),
    })
    .strict(),
  outputSchema: workflowRowSchema,
  requiredScope: 'drive:admin',
  description:
    'Update a cron-scheduled workflow. Only cron-triggered, owner/admin-manageable workflows are editable here — a backing workflow owned by a task or calendar trigger 404s. Requires drive owner or admin authority.',
});

export const deleteWorkflow = defineOperation({
  name: 'workflows.delete',
  method: 'DELETE',
  path: '/api/workflows/:workflowId',
  inputSchema: z.object({ workflowId: z.string() }).strict(),
  outputSchema: z.object({ success: z.literal(true) }),
  requiredScope: 'drive:admin',
  destructive: true,
  description:
    'Delete a cron-scheduled workflow, permanently discarding its schedule and run history reference. Requires drive owner or admin authority. Irreversible — the CLI requires --yes.',
});
