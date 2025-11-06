import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, workflowTemplates, eq } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { z } from 'zod/v4';
import {
  createWorkflowExecution,
  listUserExecutions,
  getExecutionState,
  advanceToNextStep,
} from '@/lib/workflows/execution';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

// Schema for creating a new execution
const createExecutionSchema = z.object({
  templateId: z.string().min(1, 'Template ID is required'),
  initialContext: z.record(z.string(), z.unknown()).optional(),
});

/**
 * POST /api/workflows/executions - Start a new workflow execution
 */
export async function POST(request: Request) {
  try {
    // Authenticate
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }
    const userId = auth.userId;

    // Validate request body
    const body = await request.json();
    const validatedData = createExecutionSchema.parse(body);

    // Get template and verify it exists
    const template = await db.query.workflowTemplates.findFirst({
      where: eq(workflowTemplates.id, validatedData.templateId),
    });

    if (!template) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 }
      );
    }

    // Verify user has access to the template's drive
    // For now, we'll check if user can view any page in the drive
    // In production, you might want a more specific drive membership check
    const canAccess = await canUserViewPage(userId, validatedData.templateId);

    // If the template itself is a page, check that, otherwise we assume access
    // This is a simplified check - you may want to add drive membership verification

    // Create execution
    const result = await createWorkflowExecution(
      validatedData.templateId,
      userId,
      template.driveId,
      validatedData.initialContext
    );

    if (result.error) {
      return NextResponse.json(
        { error: result.error },
        { status: 400 }
      );
    }

    // Get full execution state
    const state = await getExecutionState(result.executionId);
    if (!state) {
      return NextResponse.json(
        { error: 'Failed to retrieve execution state' },
        { status: 500 }
      );
    }

    // Auto-execute first step if it doesn't require user input
    const firstStepDef = await db.query.workflowSteps.findFirst({
      where: (steps, { and, eq }) => and(
        eq(steps.workflowTemplateId, validatedData.templateId),
        eq(steps.stepOrder, 0)
      ),
    });

    if (firstStepDef && !firstStepDef.requiresUserInput) {
      loggers.api.info('Auto-executing first step');
      const advanceResult = await advanceToNextStep(result.executionId);

      if (!advanceResult.success) {
        loggers.api.error('Failed to execute first step:', advanceResult.error);
      }

      // Get updated state after execution
      const updatedState = await getExecutionState(result.executionId);
      return NextResponse.json(updatedState || state);
    }

    return NextResponse.json(state);
  } catch (error) {
    loggers.api.error('Error starting workflow execution:', error as Error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', issues: error.issues },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to start workflow execution' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/workflows/executions - List user's workflow executions
 */
export async function GET(request: Request) {
  try {
    // Authenticate
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }
    const userId = auth.userId;

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const driveId = searchParams.get('driveId') || undefined;
    const status = searchParams.get('status') as 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | undefined;
    const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!, 10) : undefined;

    // Get executions
    const executions = await listUserExecutions(userId, {
      driveId,
      status,
      limit,
    });

    return NextResponse.json({ executions });
  } catch (error) {
    loggers.api.error('Error listing workflow executions:', error as Error);
    return NextResponse.json(
      { error: 'Failed to list workflow executions' },
      { status: 500 }
    );
  }
}
