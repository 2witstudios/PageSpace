import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import {
  getExecutionState,
  canUserAccessExecution,
} from '@/lib/workflows/execution';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

/**
 * GET /api/workflows/executions/[executionId] - Get execution status and state
 */
export async function GET(
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

    // Get execution state
    const state = await getExecutionState(executionId);
    if (!state) {
      return NextResponse.json(
        { error: 'Execution not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(state);
  } catch (error) {
    loggers.api.error('Error getting execution state:', error as Error);
    return NextResponse.json(
      { error: 'Failed to get execution state' },
      { status: 500 }
    );
  }
}
