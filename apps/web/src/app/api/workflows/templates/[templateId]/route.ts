import { NextResponse } from 'next/server';
import {
  db,
  workflowTemplates,
  workflowSteps,
  workflowExecutions,
  pages,
  eq,
  and,
  inArray,
  asc,
} from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getUserDriveAccess, isDriveOwnerOrAdmin } from '@pagespace/lib/server';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

// Schema for workflow step validation
const workflowStepSchema = z.object({
  id: z.string().optional(), // Existing step ID (for updates)
  stepOrder: z.number().int().min(0),
  agentId: z.string().min(1, 'agentId is required'),
  promptTemplate: z.string().min(1, 'promptTemplate is required'),
  requiresUserInput: z.boolean().optional().default(false),
  inputSchema: z.record(z.string(), z.any()).optional().nullable(),
  metadata: z.record(z.string(), z.any()).optional().nullable(),
});

// Schema for template updates
const updateTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  tags: z.array(z.string()).optional().nullable(),
  isPublic: z.boolean().optional(),
  steps: z.array(workflowStepSchema).optional(),
});

/**
 * GET /api/workflows/templates/[templateId]
 * Get a single workflow template with all steps
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ templateId: string }> }
) {
  const { templateId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Fetch the template
    const template = await db.query.workflowTemplates.findFirst({
      where: eq(workflowTemplates.id, templateId),
    });

    if (!template) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 }
      );
    }

    // Check access: public templates OR user has drive access
    if (!template.isPublic) {
      const hasAccess = await getUserDriveAccess(userId, template.driveId);
      if (!hasAccess) {
        return NextResponse.json(
          { error: 'Access denied' },
          { status: 403 }
        );
      }
    }

    // Fetch all steps ordered by stepOrder
    const steps = await db.query.workflowSteps.findMany({
      where: eq(workflowSteps.workflowTemplateId, templateId),
      orderBy: [asc(workflowSteps.stepOrder)],
    });

    return NextResponse.json({
      ...template,
      steps,
    });
  } catch (error) {
    loggers.api.error('Error fetching workflow template:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch workflow template' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/workflows/templates/[templateId]
 * Update a workflow template
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ templateId: string }> }
) {
  const { templateId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    const body = await request.json();
    const validatedData = updateTemplateSchema.parse(body);

    // Fetch the template
    const template = await db.query.workflowTemplates.findFirst({
      where: eq(workflowTemplates.id, templateId),
    });

    if (!template) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 }
      );
    }

    // Check if user has write permission to the drive
    const isOwnerOrAdmin = await isDriveOwnerOrAdmin(userId, template.driveId);
    if (!isOwnerOrAdmin) {
      return NextResponse.json(
        {
          error: 'Permission denied',
          details: 'Write or admin permission required to update workflow templates'
        },
        { status: 403 }
      );
    }

    // If steps are being updated, validate them
    if (validatedData.steps) {
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
    }

    // Update in a transaction
    const result = await db.transaction(async (tx) => {
      // Update template fields (exclude steps from update)
      const { steps: _, ...templateUpdateData } = validatedData;

      const templateFieldsToUpdate: Partial<typeof workflowTemplates.$inferInsert> = {};
      if (validatedData.name !== undefined) templateFieldsToUpdate.name = validatedData.name;
      if (validatedData.description !== undefined) templateFieldsToUpdate.description = validatedData.description;
      if (validatedData.category !== undefined) templateFieldsToUpdate.category = validatedData.category;
      if (validatedData.tags !== undefined) templateFieldsToUpdate.tags = validatedData.tags;
      if (validatedData.isPublic !== undefined) templateFieldsToUpdate.isPublic = validatedData.isPublic;

      let updatedTemplate = template;
      if (Object.keys(templateFieldsToUpdate).length > 0) {
        [updatedTemplate] = await tx
          .update(workflowTemplates)
          .set(templateFieldsToUpdate)
          .where(eq(workflowTemplates.id, templateId))
          .returning();
      }

      // If steps are being updated, replace all steps
      let updatedSteps;
      if (validatedData.steps) {
        // Delete all existing steps
        await tx
          .delete(workflowSteps)
          .where(eq(workflowSteps.workflowTemplateId, templateId));

        // Insert new steps
        const stepsToInsert = validatedData.steps.map(step => ({
          workflowTemplateId: templateId,
          stepOrder: step.stepOrder,
          agentId: step.agentId,
          promptTemplate: step.promptTemplate,
          requiresUserInput: step.requiresUserInput,
          inputSchema: step.inputSchema,
          metadata: step.metadata,
        }));

        updatedSteps = await tx
          .insert(workflowSteps)
          .values(stepsToInsert)
          .returning();
      } else {
        // Fetch existing steps if not updating
        updatedSteps = await tx.query.workflowSteps.findMany({
          where: eq(workflowSteps.workflowTemplateId, templateId),
          orderBy: [asc(workflowSteps.stepOrder)],
        });
      }

      return { template: updatedTemplate, steps: updatedSteps };
    });

    loggers.api.info('Workflow template updated:', {
      templateId: result.template.id,
      name: result.template.name,
      driveId: result.template.driveId,
      stepCount: result.steps.length,
      userId
    });

    return NextResponse.json({
      ...result.template,
      steps: result.steps,
    });
  } catch (error) {
    loggers.api.error('Error updating workflow template:', error as Error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', issues: error.issues },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to update workflow template' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/workflows/templates/[templateId]
 * Delete a workflow template
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ templateId: string }> }
) {
  const { templateId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Fetch the template
    const template = await db.query.workflowTemplates.findFirst({
      where: eq(workflowTemplates.id, templateId),
    });

    if (!template) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 }
      );
    }

    // Check if user has write permission to the drive
    const isOwnerOrAdmin = await isDriveOwnerOrAdmin(userId, template.driveId);
    if (!isOwnerOrAdmin) {
      return NextResponse.json(
        {
          error: 'Permission denied',
          details: 'Write or admin permission required to delete workflow templates'
        },
        { status: 403 }
      );
    }

    // Check if there are active executions of this template
    const activeExecutions = await db
      .select({ id: workflowExecutions.id })
      .from(workflowExecutions)
      .where(
        and(
          eq(workflowExecutions.workflowTemplateId, templateId),
          inArray(workflowExecutions.status, ['running', 'paused'])
        )
      )
      .limit(1);

    if (activeExecutions.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot delete template',
          details: 'There are active workflow executions using this template. Please wait for them to complete or cancel them first.'
        },
        { status: 409 } // 409 Conflict
      );
    }

    // Delete the template (steps will cascade delete automatically)
    await db
      .delete(workflowTemplates)
      .where(eq(workflowTemplates.id, templateId));

    loggers.api.info('Workflow template deleted:', {
      templateId,
      name: template.name,
      driveId: template.driveId,
      userId
    });

    return NextResponse.json({
      success: true,
      message: 'Workflow template deleted successfully',
      templateId,
    });
  } catch (error) {
    loggers.api.error('Error deleting workflow template:', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete workflow template' },
      { status: 500 }
    );
  }
}
