import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import {
  getExecutionState,
  canUserAccessExecution,
  advanceToNextStep,
} from '@/lib/workflows/execution';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

/**
 * POST /api/workflows/executions/[executionId]/next - Execute next step
 *
 * Advances to the next step in the workflow and executes it if it doesn't require user input.
 * If the next step requires user input, the execution will pause waiting for input.
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

    // Verify execution is in a valid state
    const currentState = await getExecutionState(executionId);
    if (!currentState) {
      return NextResponse.json(
        { error: 'Execution not found' },
        { status: 404 }
      );
    }

    if (currentState.execution.status !== 'running') {
      return NextResponse.json(
        {
          error: 'Cannot execute next step',
          details: `Execution is ${currentState.execution.status}`
        },
        { status: 400 }
      );
    }

    // Advance to next step
    const result = await advanceToNextStep(executionId);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || 'Failed to execute next step' },
        { status: 500 }
      );
    }

    // Get updated execution state
    const updatedState = await getExecutionState(executionId);
    if (!updatedState) {
      return NextResponse.json(
        { error: 'Failed to retrieve updated execution state' },
        { status: 500 }
      );
    }

    // Add metadata about what happened
    const response = {
      ...updatedState,
      metadata: {
        completed: result.completed || false,
        requiresUserInput: result.requiresUserInput || false,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    loggers.api.error('Error executing next step:', error as Error);
    return NextResponse.json(
      { error: 'Failed to execute next step' },
      { status: 500 }
    );
  }
}
