import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, workflowSteps, eq } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { z } from 'zod/v4';
import {
  getExecutionState,
  canUserAccessExecution,
  executeWorkflowStep,
  advanceToNextStep,
} from '@/lib/workflows/execution';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

// Schema for user input
const userInputSchema = z.object({
  userInput: z.record(z.string(), z.unknown()),
});

/**
 * POST /api/workflows/executions/[executionId]/input - Submit user input for current step
 *
 * Allows the user to provide required input for a step that has requiresUserInput=true.
 * After receiving input, the step is executed and the workflow advances.
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

    // Validate request body
    const body = await request.json();
    const validatedData = userInputSchema.parse(body);

    // Get current execution state
    const state = await getExecutionState(executionId);
    if (!state) {
      return NextResponse.json(
        { error: 'Execution not found' },
        { status: 404 }
      );
    }

    if (state.execution.status !== 'running') {
      return NextResponse.json(
        {
          error: 'Cannot submit input',
          details: `Execution is ${state.execution.status}`
        },
        { status: 400 }
      );
    }

    // Get current step
    const currentStepOrder = state.execution.currentStepOrder;
    if (currentStepOrder === null) {
      return NextResponse.json(
        { error: 'No current step to provide input for' },
        { status: 400 }
      );
    }

    const currentStep = state.steps.find(s => s.stepOrder === currentStepOrder);
    if (!currentStep) {
      return NextResponse.json(
        { error: 'Current step not found' },
        { status: 404 }
      );
    }

    // Verify step requires user input
    const stepDef = await db.query.workflowSteps.findFirst({
      where: eq(workflowSteps.id, currentStep.workflowStepId!),
    });

    if (!stepDef) {
      return NextResponse.json(
        { error: 'Step definition not found' },
        { status: 404 }
      );
    }

    if (!stepDef.requiresUserInput) {
      return NextResponse.json(
        { error: 'Current step does not require user input' },
        { status: 400 }
      );
    }

    // Validate input against schema if defined
    if (stepDef.inputSchema) {
      try {
        const inputSchemaValidator = z.record(z.string(), z.unknown());
        // In production, you'd parse the JSON schema and create a proper Zod validator
        // For now, we just validate it's an object
        inputSchemaValidator.parse(validatedData.userInput);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return NextResponse.json(
            { error: 'Input validation failed', issues: error.issues },
            { status: 400 }
          );
        }
        throw error;
      }
    }

    // Execute the step with user input
    const executeResult = await executeWorkflowStep(
      executionId,
      currentStepOrder,
      validatedData.userInput
    );

    if (!executeResult.success) {
      return NextResponse.json(
        { error: executeResult.error || 'Failed to execute step with input' },
        { status: 500 }
      );
    }

    // Advance to next step
    const advanceResult = await advanceToNextStep(executionId);

    if (!advanceResult.success) {
      loggers.api.error('Failed to advance after user input:', advanceResult.error);
    }

    // Get updated execution state
    const updatedState = await getExecutionState(executionId);
    if (!updatedState) {
      return NextResponse.json(
        { error: 'Failed to retrieve updated execution state' },
        { status: 500 }
      );
    }

    return NextResponse.json(updatedState);
  } catch (error) {
    loggers.api.error('Error submitting user input:', error as Error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', issues: error.issues },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to submit user input' },
      { status: 500 }
    );
  }
}
