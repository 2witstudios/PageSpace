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
 * POST /api/workflows/executions/[executionId]/pause - Pause execution
 *
 * Pauses a running workflow execution. The execution can be resumed later.
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

    // Can only pause running executions
    if (state.execution.status !== 'running') {
      return NextResponse.json(
        {
          error: 'Cannot pause execution',
          details: `Execution is ${state.execution.status}`
        },
        { status: 400 }
      );
    }

    // Update status to paused
    await db.update(workflowExecutions)
      .set({
        status: 'paused',
        pausedAt: new Date(),
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
    loggers.api.error('Error pausing execution:', error as Error);
    return NextResponse.json(
      { error: 'Failed to pause execution' },
      { status: 500 }
    );
  }
}
