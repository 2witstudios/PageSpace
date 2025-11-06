import { NextResponse } from 'next/server';
import {
  db,
  workflowTemplates,
  workflowSteps,
  pages,
  eq,
  and,
  or,
  inArray,
  desc,
  sql
} from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getUserDriveAccess, isDriveOwnerOrAdmin } from '@pagespace/lib/server';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

// Schema for workflow step validation
const workflowStepSchema = z.object({
  stepOrder: z.number().int().min(0),
  agentId: z.string().min(1, 'agentId is required'),
  promptTemplate: z.string().min(1, 'promptTemplate is required'),
  requiresUserInput: z.boolean().optional().default(false),
  inputSchema: z.record(z.string(), z.any()).optional().nullable(),
  metadata: z.record(z.string(), z.any()).optional().nullable(),
});

// Schema for template creation
const createTemplateSchema = z.object({
  name: z.string().min(1, 'name is required').max(255),
  description: z.string().optional().nullable(),
  driveId: z.string().min(1, 'driveId is required'),
  category: z.string().optional().nullable(),
  tags: z.array(z.string()).optional().nullable(),
  isPublic: z.boolean().default(false),
  steps: z.array(workflowStepSchema).min(1, 'At least one step is required'),
});

/**
 * GET /api/workflows/templates
 * List all workflow templates (filtered by access)
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const { searchParams } = new URL(request.url);
    const driveId = searchParams.get('driveId');
    const category = searchParams.get('category');
    const tagsParam = searchParams.get('tags');
    const tags = tagsParam ? tagsParam.split(',').map(t => t.trim()) : null;

    // Build WHERE conditions
    const conditions = [];

    // Filter by driveId if provided
    if (driveId) {
      // Check if user has access to this drive
      const hasAccess = await getUserDriveAccess(userId, driveId);
      if (!hasAccess) {
        return NextResponse.json(
          { error: 'Access denied to this drive' },
          { status: 403 }
        );
      }
      conditions.push(eq(workflowTemplates.driveId, driveId));
    } else {
      // If no driveId specified, return only public templates or templates from accessible drives
      // For simplicity, we'll get public templates + templates where user has drive access
      // This will be handled in the query below
    }

    // Filter by category if provided
    if (category) {
      conditions.push(eq(workflowTemplates.category, category));
    }

    // Filter by tags if provided (PostgreSQL array contains)
    if (tags && tags.length > 0) {
      // Check if any of the provided tags exist in the template's tags array
      conditions.push(
        sql`${workflowTemplates.tags} && ${tags}`
      );
    }

    // Query templates with step counts
    let query = db
      .select({
        id: workflowTemplates.id,
        name: workflowTemplates.name,
        description: workflowTemplates.description,
        driveId: workflowTemplates.driveId,
        createdBy: workflowTemplates.createdBy,
        category: workflowTemplates.category,
        tags: workflowTemplates.tags,
        isPublic: workflowTemplates.isPublic,
        createdAt: workflowTemplates.createdAt,
        updatedAt: workflowTemplates.updatedAt,
        stepCount: sql<number>`COUNT(${workflowSteps.id})::int`,
      })
      .from(workflowTemplates)
      .leftJoin(workflowSteps, eq(workflowTemplates.id, workflowSteps.workflowTemplateId))
      .groupBy(workflowTemplates.id);

    // Apply WHERE conditions
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    // Order by most recent first
    query = query.orderBy(desc(workflowTemplates.createdAt)) as typeof query;

    let templates = await query;

    // If no driveId filter, filter for accessible templates only
    if (!driveId) {
      // Get list of drives user has access to
      const accessibleDrives = await db.query.drives.findMany({
        where: or(
          eq(sql`${sql.identifier('drives', 'ownerId')}`, userId),
          sql`EXISTS (
            SELECT 1 FROM drive_members
            WHERE drive_members.drive_id = drives.id
            AND drive_members.user_id = ${userId}
          )`
        ),
        columns: { id: true }
      });

      const accessibleDriveIds = new Set(accessibleDrives.map(d => d.id));

      // Filter templates: public OR in accessible drives
      templates = templates.filter(
        t => t.isPublic || accessibleDriveIds.has(t.driveId)
      );
    }

    return NextResponse.json({ templates });
  } catch (error) {
    loggers.api.error('Error fetching workflow templates:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch workflow templates' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/workflows/templates
 * Create a new workflow template
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const body = await request.json();
    const validatedData = createTemplateSchema.parse(body);

    // Check if user has write permission to the drive
    const isOwnerOrAdmin = await isDriveOwnerOrAdmin(userId, validatedData.driveId);
    if (!isOwnerOrAdmin) {
      return NextResponse.json(
        {
          error: 'Permission denied',
          details: 'Write or admin permission required to create workflow templates'
        },
        { status: 403 }
      );
    }

    // Validate that all agentIds exist and are AI_CHAT pages
    const agentIds = validatedData.steps.map(step => step.agentId);
    const uniqueAgentIds = Array.from(new Set(agentIds));

    const agentPages = await db
      .select({ id: pages.id, type: pages.type })
      .from(pages)
      .where(inArray(pages.id, uniqueAgentIds));

    const foundAgentIds = new Set(agentPages.map(p => p.id));
    const missingAgentIds = uniqueAgentIds.filter(id => !foundAgentIds.has(id));

    if (missingAgentIds.length > 0) {
      return NextResponse.json(
        {
          error: 'Invalid agentIds',
          details: `The following agent IDs do not exist: ${missingAgentIds.join(', ')}`
        },
        { status: 400 }
      );
    }

    // Check that all found pages are AI_CHAT type
    const nonAgentPages = agentPages.filter(p => p.type !== 'AI_CHAT');
    if (nonAgentPages.length > 0) {
      return NextResponse.json(
        {
          error: 'Invalid agentIds',
          details: `The following IDs are not AI agents: ${nonAgentPages.map(p => p.id).join(', ')}`
        },
        { status: 400 }
      );
    }

    // Validate stepOrder: must be sequential and unique
    const stepOrders = validatedData.steps.map(step => step.stepOrder);
    const uniqueStepOrders = new Set(stepOrders);

    if (uniqueStepOrders.size !== stepOrders.length) {
      return NextResponse.json(
        {
          error: 'Invalid step order',
          details: 'stepOrder values must be unique within the template'
        },
        { status: 400 }
      );
    }

    // Sort steps by stepOrder to ensure sequential validation
    const sortedSteps = [...validatedData.steps].sort((a, b) => a.stepOrder - b.stepOrder);
    for (let i = 0; i < sortedSteps.length; i++) {
      if (sortedSteps[i].stepOrder !== i) {
        return NextResponse.json(
          {
            error: 'Invalid step order',
            details: `stepOrder must be sequential starting from 0. Expected ${i}, got ${sortedSteps[i].stepOrder}`
          },
          { status: 400 }
        );
      }
    }

    // Create template and steps in a transaction
    const result = await db.transaction(async (tx) => {
      // Create the template
      const [newTemplate] = await tx
        .insert(workflowTemplates)
        .values({
          name: validatedData.name,
          description: validatedData.description,
          driveId: validatedData.driveId,
          createdBy: userId,
          category: validatedData.category,
          tags: validatedData.tags,
          isPublic: validatedData.isPublic,
        })
        .returning();

      // Create all steps
      const stepsToInsert = validatedData.steps.map(step => ({
        workflowTemplateId: newTemplate.id,
        stepOrder: step.stepOrder,
        agentId: step.agentId,
        promptTemplate: step.promptTemplate,
        requiresUserInput: step.requiresUserInput,
        inputSchema: step.inputSchema,
        metadata: step.metadata,
      }));

      const newSteps = await tx
        .insert(workflowSteps)
        .values(stepsToInsert)
        .returning();

      return { template: newTemplate, steps: newSteps };
    });

    loggers.api.info('Workflow template created:', {
      templateId: result.template.id,
      name: result.template.name,
      driveId: result.template.driveId,
      stepCount: result.steps.length,
      userId
    });

    // Return the created template with steps
    return NextResponse.json({
      ...result.template,
      steps: result.steps,
    }, { status: 201 });

  } catch (error) {
    loggers.api.error('Error creating workflow template:', error as Error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', issues: error.issues },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to create workflow template' },
      { status: 500 }
    );
  }
}
