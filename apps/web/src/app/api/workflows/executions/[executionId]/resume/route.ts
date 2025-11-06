import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, workflowExecutions, eq } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import {
  getExecutionState,
  canUserAccessExecution,
  advanceToNextStep,
} from '@/lib/workflows/execution';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

/**
 * POST /api/workflows/executions/[executionId]/resume - Resume paused execution
 *
 * Resumes a paused workflow execution. If the current step doesn't require user input,
 * it will be automatically executed.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ executionId: string }> }
) {
  try {
    // MUST await params (Next.js 15)
    const { executionId } = await context.params;

    // Authenticate
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }
    const userId = auth.userId;

    // Verify user has access to this execution
    const canAccess = await canUserAccessExecution(userId, executionId);
    if (!canAccess) {
      return NextResponse.json(
        { error: 'Execution not found or access denied' },
        { status: 404 }
      );
    }

    // Get current state
    const state = await getExecutionState(executionId);
    if (!state) {
      return NextResponse.json(
        { error: 'Execution not found' },
        { status: 404 }
      );
    }

    // Can only resume paused executions
    if (state.execution.status !== 'paused') {
      return NextResponse.json(
        {
          error: 'Cannot resume execution',
          details: `Execution is ${state.execution.status}`
        },
        { status: 400 }
      );
    }

    // Update status to running
    await db.update(workflowExecutions)
      .set({
        status: 'running',
        pausedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(workflowExecutions.id, executionId));

    // Try to auto-execute next step if applicable
    // This will check if the current step requires user input
    const currentStepOrder = state.execution.currentStepOrder;
    if (currentStepOrder !== null) {
      const currentStep = state.steps.find(s => s.stepOrder === currentStepOrder);

      // If current step is pending, try to execute it
      if (currentStep && currentStep.status === 'pending') {
        const stepDef = await db.query.workflowSteps.findFirst({
          where: (steps, { eq }) => eq(steps.id, currentStep.workflowStepId!),
        });

        if (stepDef && !stepDef.requiresUserInput) {
          const advanceResult = await advanceToNextStep(executionId);
          if (!advanceResult.success) {
            loggers.api.error('Failed to execute step after resume:', advanceResult.error);
          }
        }
      }
    }

    // Get updated state
    const updatedState = await getExecutionState(executionId);

    return NextResponse.json({
      success: true,
      execution: updatedState,
    });
  } catch (error) {
    loggers.api.error('Error resuming execution:', error as Error);
    return NextResponse.json(
      { error: 'Failed to resume execution' },
      { status: 500 }
    );
  }
}
