import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, workflowExecutions, eq } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import {
  getExecutionState,
  canUserAccessExecution,
} from '@/lib/workflows/execution';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

/**
 * POST /api/workflows/executions/[executionId]/cancel - Cancel execution
 *
 * Cancels a workflow execution. This cannot be undone.
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

    // Cannot cancel already completed or failed executions
    if (state.execution.status === 'completed' || state.execution.status === 'failed') {
      return NextResponse.json(
        {
          error: 'Cannot cancel execution',
          details: `Execution is already ${state.execution.status}`
        },
        { status: 400 }
      );
    }

    // Update status to cancelled
    await db.update(workflowExecutions)
      .set({
        status: 'cancelled',
        updatedAt: new Date(),
      })
      .where(eq(workflowExecutions.id, executionId));

    // Get updated state
    const updatedState = await getExecutionState(executionId);

    return NextResponse.json({
      success: true,
      execution: updatedState,
    });
  } catch (error) {
    loggers.api.error('Error cancelling execution:', error as Error);
    return NextResponse.json(
      { error: 'Failed to cancel execution' },
      { status: 500 }
    );
  }
}
