import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { db, workflows, pages, eq, and } from '@pagespace/db';
import { validateCronExpression, validateTimezone, getNextRunDate } from '@/lib/workflows/cron-utils';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };
const MANAGEABLE_TRIGGER_TYPE = 'cron' as const;

const createWorkflowSchema = z.object({
  driveId: z.string().min(1),
  name: z.string().min(1).max(200),
  agentPageId: z.string().min(1),
  prompt: z.string().min(1),
  contextPageIds: z.array(z.string()).default([]),
  cronExpression: z.string().min(1),
  timezone: z.string().default('UTC'),
  isEnabled: z.boolean().default(true),
}).strict();

// GET /api/workflows?driveId=xxx - List scheduled workflows for a drive
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, { allow: ['session'] as const, requireCSRF: false });
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { searchParams } = new URL(request.url);
  const driveId = searchParams.get('driveId');

  if (!driveId) {
    return NextResponse.json({ error: 'driveId is required' }, { status: 400 });
  }

  const access = await checkDriveAccess(driveId, userId);
  if (!access.drive) {
    return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
  }
  if (!access.isOwner && !access.isAdmin) {
    return NextResponse.json({ error: 'Only drive owners and admins can manage workflows' }, { status: 403 });
  }

  const results = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.driveId, driveId), eq(workflows.triggerType, MANAGEABLE_TRIGGER_TYPE)))
    .orderBy(workflows.createdAt);

  auditRequest(request, { eventType: 'data.read', userId, resourceType: 'workflow', resourceId: driveId, details: { count: results.length } });

  return NextResponse.json(results);
}

// POST /api/workflows - Create a new scheduled workflow
export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const body = await request.json();
  const parsed = createWorkflowSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 });
  }

  const data = parsed.data;

  // Check drive access - must be owner or admin
  const access = await checkDriveAccess(data.driveId, userId);
  if (!access.drive) {
    return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
  }
  if (!access.isOwner && !access.isAdmin) {
    return NextResponse.json({ error: 'Only drive owners and admins can manage workflows' }, { status: 403 });
  }

  // Validate agent page exists, is AI_CHAT, not trashed, and in the same drive
  const [agent] = await db
    .select()
    .from(pages)
    .where(and(eq(pages.id, data.agentPageId), eq(pages.driveId, data.driveId), eq(pages.isTrashed, false)));

  if (!agent) {
    return NextResponse.json({ error: 'Agent page not found in this drive' }, { status: 400 });
  }
  if (agent.type !== 'AI_CHAT') {
    return NextResponse.json({ error: 'Selected page is not an AI agent' }, { status: 400 });
  }

  // Validate timezone
  const tzValidation = validateTimezone(data.timezone);
  if (!tzValidation.valid) {
    return NextResponse.json({ error: tzValidation.error }, { status: 400 });
  }

  // Validate cron expression for cron-type workflows
  let nextRunAt: Date | null = null;
  const cronValidation = validateCronExpression(data.cronExpression);
  if (!cronValidation.valid) {
    return NextResponse.json({ error: `Invalid cron expression: ${cronValidation.error}` }, { status: 400 });
  }
  nextRunAt = data.isEnabled ? getNextRunDate(data.cronExpression, data.timezone) : null;

  const [workflow] = await db.insert(workflows).values({
    driveId: data.driveId,
    createdBy: userId,
    name: data.name,
    agentPageId: data.agentPageId,
    prompt: data.prompt,
    contextPageIds: data.contextPageIds,
    triggerType: MANAGEABLE_TRIGGER_TYPE,
    cronExpression: data.cronExpression,
    timezone: data.timezone,
    isEnabled: data.isEnabled,
    eventTriggers: null,
    watchedFolderIds: null,
    eventDebounceSecs: null,
    nextRunAt,
    updatedAt: new Date(),
  }).returning();

  auditRequest(request, { eventType: 'data.write', userId, resourceType: 'workflow', resourceId: workflow.id, details: { driveId: data.driveId, triggerType: MANAGEABLE_TRIGGER_TYPE } });

  return NextResponse.json(workflow, { status: 201 });
}
