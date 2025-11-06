import { db, workflowExecutions, workflowExecutionSteps, workflowSteps, workflowTemplates, eq, and, asc, desc, pages, chatMessages } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/server';
import { canUserViewPage } from '@pagespace/lib/server';
import { generateText } from 'ai';
import {
  createAIProvider,
  isProviderError,
  type ProviderRequest
} from '@/lib/ai/provider-factory';
import { pageSpaceTools } from '@/lib/ai/ai-tools';
import { ToolPermissionFilter } from '@/lib/ai/tool-permissions';
import { AgentRole } from '@/lib/ai/agent-roles';

/**
 * Full execution state including all steps
 */
export interface ExecutionState {
  execution: {
    id: string;
    workflowTemplateId: string;
    userId: string;
    driveId: string;
    status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    currentStepOrder: number | null;
    accumulatedContext: Record<string, unknown>;
    startedAt: Date | null;
    pausedAt: Date | null;
    completedAt: Date | null;
    failedAt: Date | null;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  steps: Array<{
    id: string;
    workflowExecutionId: string;
    workflowStepId: string | null;
    stepOrder: number;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    agentInput: Record<string, unknown> | null;
    agentOutput: Record<string, unknown> | null;
    userInput: Record<string, unknown> | null;
    startedAt: Date | null;
    completedAt: Date | null;
    errorMessage: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  template?: {
    id: string;
    name: string;
    description: string | null;
  };
  progressPercentage: number;
}

/**
 * Get full execution state with all steps
 */
export async function getExecutionState(executionId: string): Promise<ExecutionState | null> {
  try {
    // Get execution with template info
    const execution = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.id, executionId),
      with: {
        template: {
          columns: {
            id: true,
            name: true,
            description: true,
          },
        },
      },
    });

    if (!execution) {
      return null;
    }

    // Get all execution steps
    const steps = await db.query.workflowExecutionSteps.findMany({
      where: eq(workflowExecutionSteps.workflowExecutionId, executionId),
      orderBy: [asc(workflowExecutionSteps.stepOrder)],
    });

    // Calculate progress
    const totalSteps = steps.length;
    const completedSteps = steps.filter(s => s.status === 'completed').length;
    const progressPercentage = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

    return {
      execution: {
        ...execution,
        accumulatedContext: execution.accumulatedContext as Record<string, unknown>,
      },
      steps: steps.map(step => ({
        ...step,
        agentInput: step.agentInput as Record<string, unknown> | null,
        agentOutput: step.agentOutput as Record<string, unknown> | null,
        userInput: step.userInput as Record<string, unknown> | null,
      })),
      template: execution.template,
      progressPercentage,
    };
  } catch (error) {
    loggers.api.error('Error getting execution state:', error as Error);
    return null;
  }
}

/**
 * Process prompt template by replacing variables with context data
 * Supports: {{context}}, {{stepN.output}}, {{userInput}}, {{initialContext.key}}
 */
export function processPromptTemplate(
  template: string,
  context: Record<string, unknown>
): string {
  let processed = template;

  // Replace {{context}} with full JSON
  processed = processed.replace(/\{\{context\}\}/g, JSON.stringify(context, null, 2));

  // Replace {{stepN.output}}
  const stepOutputPattern = /\{\{step(\d+)\.output\}\}/g;
  processed = processed.replace(stepOutputPattern, (match, stepNum) => {
    const key = `step${stepNum}Output`;
    const value = context[key];
    if (value === undefined) {
      return match; // Keep original if not found
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  });

  // Replace {{userInputN}}
  const userInputPattern = /\{\{userInput(\d+)\}\}/g;
  processed = processed.replace(userInputPattern, (match, inputNum) => {
    const key = `userInput${inputNum}`;
    const value = context[key];
    if (value === undefined) {
      return match;
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  });

  // Replace {{initialContext.key}}
  const initialContextPattern = /\{\{initialContext\.(\w+)\}\}/g;
  processed = processed.replace(initialContextPattern, (match, key) => {
    const initialContext = context.initialContext as Record<string, unknown> | undefined;
    const value = initialContext?.[key];
    if (value === undefined) {
      return match;
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  });

  // Replace {{key}} for top-level context keys
  const simpleKeyPattern = /\{\{(\w+)\}\}/g;
  processed = processed.replace(simpleKeyPattern, (match, key) => {
    const value = context[key];
    if (value === undefined) {
      return match;
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  });

  return processed;
}

/**
 * Update accumulated context with new data
 */
export async function updateExecutionContext(
  executionId: string,
  newData: Record<string, unknown>
): Promise<void> {
  const execution = await db.query.workflowExecutions.findFirst({
    where: eq(workflowExecutions.id, executionId),
  });

  if (!execution) {
    throw new Error('Execution not found');
  }

  const currentContext = execution.accumulatedContext as Record<string, unknown>;
  const updatedContext = { ...currentContext, ...newData };

  await db.update(workflowExecutions)
    .set({
      accumulatedContext: updatedContext,
      updatedAt: new Date(),
    })
    .where(eq(workflowExecutions.id, executionId));
}

/**
 * Execute an AI agent with the given prompt
 * This is a synchronous version of the AI chat system for workflow integration
 */
async function executeAgentStep(
  agentId: string,
  processedPrompt: string,
  userId: string,
  executionId: string
): Promise<{ content: string; metadata: Record<string, unknown> }> {
  try {
    loggers.api.info(`Executing AI agent ${agentId} for workflow execution ${executionId}`);

    // 1. Get agent page configuration
    const [agentPage] = await db.select().from(pages).where(eq(pages.id, agentId));
    if (!agentPage) {
      throw new Error(`Agent page not found: ${agentId}`);
    }

    if (agentPage.type !== 'AI_CHAT') {
      throw new Error(`Page ${agentId} is not an AI_CHAT page (type: ${agentPage.type})`);
    }

    // 2. Create conversationId for this workflow execution
    const conversationId = `workflow-${executionId}-${createId()}`;

    // 3. Create user message in agent's chat
    const userMessageId = createId();
    await db.insert(chatMessages).values({
      id: userMessageId,
      pageId: agentId,
      conversationId,
      userId,
      role: 'user',
      content: processedPrompt,
      toolCalls: null,
      toolResults: null,
      createdAt: new Date(),
      isActive: true,
      agentRole: agentPage.title || 'Workflow Agent',
    });

    loggers.api.debug(`Created user message ${userMessageId} in agent ${agentId}`);

    // 4. Create AI provider using agent's configuration (or user defaults)
    const providerRequest: ProviderRequest = {
      selectedProvider: agentPage.aiProvider || undefined,
      selectedModel: agentPage.aiModel || undefined,
    };

    const providerResult = await createAIProvider(userId, providerRequest);
    if (isProviderError(providerResult)) {
      throw new Error(`Failed to create AI provider: ${providerResult.error}`);
    }

    loggers.api.debug(`Created AI provider: ${providerResult.provider}/${providerResult.modelName}`);

    // 5. Build system prompt for agent
    const systemPrompt = agentPage.systemPrompt ||
      'You are a helpful AI assistant executing a workflow step. Provide clear, concise responses focused on the task at hand.';

    // 6. Filter tools based on agent configuration
    const enabledTools = agentPage.enabledTools as string[] | null;
    let filteredTools;
    if (enabledTools && enabledTools.length > 0) {
      // Use agent's specific tool configuration
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filtered: Record<string, any> = {};
      for (const toolName of enabledTools) {
        if (toolName in pageSpaceTools) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filtered[toolName] = (pageSpaceTools as any)[toolName];
        }
      }
      filteredTools = filtered;
      loggers.api.debug(`Agent using ${Object.keys(filteredTools).length} enabled tools`);
    } else {
      // Use default PARTNER role tools
      filteredTools = ToolPermissionFilter.filterTools(pageSpaceTools, AgentRole.PARTNER);
      loggers.api.debug(`Agent using default PARTNER role tools`);
    }

    // 7. Execute AI synchronously using generateText
    loggers.api.debug(`Starting AI generation for agent ${agentId}`);
    const startTime = Date.now();

    const result = await generateText({
      model: providerResult.model,
      system: systemPrompt,
      prompt: processedPrompt,
      tools: filteredTools,
      // Note: Tool execution will continue until the model stops calling tools
      // or reaches the model's internal limits
      experimental_context: {
        userId,
        workflowExecution: {
          executionId,
          agentId,
        }
      },
    });

    const executionTime = Date.now() - startTime;
    loggers.api.info(`AI generation completed in ${executionTime}ms for agent ${agentId}`);

    // 8. Extract response text
    const responseText = result.text;

    // 9. Save AI response message to agent's chat
    const assistantMessageId = createId();
    await db.insert(chatMessages).values({
      id: assistantMessageId,
      pageId: agentId,
      conversationId,
      userId: null, // AI message (no userId)
      role: 'assistant',
      content: responseText,
      toolCalls: result.toolCalls ? JSON.stringify(result.toolCalls) : null,
      toolResults: result.toolResults ? JSON.stringify(result.toolResults) : null,
      createdAt: new Date(),
      isActive: true,
      agentRole: agentPage.title || 'Workflow Agent',
    });

    loggers.api.debug(`Saved assistant message ${assistantMessageId} in agent ${agentId}`);

    // 10. Return response with metadata
    return {
      content: responseText,
      metadata: {
        conversationId,
        userMessageId,
        assistantMessageId,
        agentId,
        agentTitle: agentPage.title,
        provider: providerResult.provider,
        model: providerResult.modelName,
        executionTimeMs: executionTime,
        tokenUsage: {
          prompt: result.usage?.inputTokens,
          completion: result.usage?.outputTokens,
          total: result.usage?.totalTokens,
        },
        toolCallsCount: result.toolCalls?.length || 0,
        toolResultsCount: result.toolResults?.length || 0,
      }
    };
  } catch (error) {
    loggers.api.error(`Error executing AI agent ${agentId}:`, error as Error);
    throw new Error(
      `Agent execution failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Execute a single workflow step
 * This is a simplified version - full implementation would integrate with AI chat
 */
export async function executeWorkflowStep(
  executionId: string,
  stepOrder: number,
  userInput?: Record<string, unknown>
): Promise<{ success: boolean; output?: Record<string, unknown>; error?: string }> {
  try {
    loggers.api.info(`Executing workflow step ${stepOrder} for execution ${executionId}`);

    // Get execution state
    const state = await getExecutionState(executionId);
    if (!state) {
      return { success: false, error: 'Execution not found' };
    }

    // Find the execution step
    const executionStep = state.steps.find(s => s.stepOrder === stepOrder);
    if (!executionStep) {
      return { success: false, error: `Step ${stepOrder} not found` };
    }

    // Get the step definition
    const stepDef = await db.query.workflowSteps.findFirst({
      where: eq(workflowSteps.id, executionStep.workflowStepId!),
    });

    if (!stepDef) {
      return { success: false, error: 'Step definition not found' };
    }

    // Mark step as running
    await db.update(workflowExecutionSteps)
      .set({
        status: 'running',
        startedAt: new Date(),
        userInput: userInput || null,
        updatedAt: new Date(),
      })
      .where(eq(workflowExecutionSteps.id, executionStep.id));

    // Process prompt template with accumulated context
    let contextWithUserInput = { ...state.execution.accumulatedContext };
    if (userInput) {
      contextWithUserInput[`userInput${stepOrder}`] = userInput;
    }

    const processedPrompt = processPromptTemplate(stepDef.promptTemplate, contextWithUserInput);

    // Prepare agent input
    const agentInput = {
      prompt: processedPrompt,
      agentId: stepDef.agentId,
      context: contextWithUserInput,
    };

    // Save agent input
    await db.update(workflowExecutionSteps)
      .set({
        agentInput,
        updatedAt: new Date(),
      })
      .where(eq(workflowExecutionSteps.id, executionStep.id));

    // Execute AI agent with real integration
    const agentResult = await executeAgentStep(
      stepDef.agentId,
      processedPrompt,
      state.execution.userId,
      executionId
    );

    const agentOutput = {
      type: 'text',
      content: agentResult.content,
      metadata: agentResult.metadata,
    };

    // Mark step as completed
    await db.update(workflowExecutionSteps)
      .set({
        status: 'completed',
        agentOutput,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workflowExecutionSteps.id, executionStep.id));

    // Update accumulated context
    await updateExecutionContext(executionId, {
      [`step${stepOrder}Output`]: agentOutput.content,
      ...(userInput ? { [`userInput${stepOrder}`]: userInput } : {}),
    });

    return { success: true, output: agentOutput };
  } catch (error) {
    loggers.api.error(`Error executing workflow step ${stepOrder}:`, error as Error);

    // Mark step as failed
    const executionStep = await db.query.workflowExecutionSteps.findFirst({
      where: and(
        eq(workflowExecutionSteps.workflowExecutionId, executionId),
        eq(workflowExecutionSteps.stepOrder, stepOrder)
      ),
    });

    if (executionStep) {
      await db.update(workflowExecutionSteps)
        .set({
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
          updatedAt: new Date(),
        })
        .where(eq(workflowExecutionSteps.id, executionStep.id));
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Create a new workflow execution with initial step records
 */
export async function createWorkflowExecution(
  templateId: string,
  userId: string,
  driveId: string,
  initialContext?: Record<string, unknown>
): Promise<{ executionId: string; error?: string }> {
  try {
    // Get template with steps
    const template = await db.query.workflowTemplates.findFirst({
      where: eq(workflowTemplates.id, templateId),
      with: {
        steps: {
          orderBy: [asc(workflowSteps.stepOrder)],
        },
      },
    });

    if (!template) {
      return { executionId: '', error: 'Template not found' };
    }

    if (template.steps.length === 0) {
      return { executionId: '', error: 'Template has no steps' };
    }

    // Create execution
    const executionId = createId();
    const now = new Date();

    await db.insert(workflowExecutions).values({
      id: executionId,
      workflowTemplateId: templateId,
      userId,
      driveId,
      status: 'running',
      currentStepOrder: 0,
      accumulatedContext: initialContext ? { initialContext } : {},
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Create execution step records
    const executionSteps = template.steps.map(step => ({
      id: createId(),
      workflowExecutionId: executionId,
      workflowStepId: step.id,
      stepOrder: step.stepOrder,
      status: 'pending' as const,
      createdAt: now,
      updatedAt: now,
    }));

    await db.insert(workflowExecutionSteps).values(executionSteps);

    loggers.api.info(`Created workflow execution ${executionId} with ${executionSteps.length} steps`);

    return { executionId };
  } catch (error) {
    loggers.api.error('Error creating workflow execution:', error as Error);
    return {
      executionId: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Advance to next step and execute if applicable
 */
export async function advanceToNextStep(
  executionId: string
): Promise<{ success: boolean; completed?: boolean; requiresUserInput?: boolean; error?: string }> {
  try {
    const state = await getExecutionState(executionId);
    if (!state) {
      return { success: false, error: 'Execution not found' };
    }

    const currentStepOrder = state.execution.currentStepOrder ?? -1;
    const nextStepOrder = currentStepOrder + 1;

    // Check if there are more steps
    const nextStep = state.steps.find(s => s.stepOrder === nextStepOrder);
    if (!nextStep) {
      // No more steps - mark execution as completed
      await db.update(workflowExecutions)
        .set({
          status: 'completed',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(workflowExecutions.id, executionId));

      return { success: true, completed: true };
    }

    // Update current step order
    await db.update(workflowExecutions)
      .set({
        currentStepOrder: nextStepOrder,
        updatedAt: new Date(),
      })
      .where(eq(workflowExecutions.id, executionId));

    // Get step definition to check if it requires user input
    const stepDef = await db.query.workflowSteps.findFirst({
      where: eq(workflowSteps.id, nextStep.workflowStepId!),
    });

    if (stepDef?.requiresUserInput) {
      return { success: true, requiresUserInput: true };
    }

    // Auto-execute if no user input required
    const result = await executeWorkflowStep(executionId, nextStepOrder);
    if (!result.success) {
      // Mark execution as failed
      await db.update(workflowExecutions)
        .set({
          status: 'failed',
          errorMessage: result.error,
          failedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(workflowExecutions.id, executionId));

      return { success: false, error: result.error };
    }

    return { success: true };
  } catch (error) {
    loggers.api.error('Error advancing to next step:', error as Error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if user has access to a workflow execution
 */
export async function canUserAccessExecution(
  userId: string,
  executionId: string
): Promise<boolean> {
  const execution = await db.query.workflowExecutions.findFirst({
    where: eq(workflowExecutions.id, executionId),
  });

  if (!execution) {
    return false;
  }

  // User must be the execution owner
  return execution.userId === userId;
}

/**
 * List user's workflow executions
 */
export async function listUserExecutions(
  userId: string,
  options?: {
    driveId?: string;
    status?: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    limit?: number;
  }
): Promise<ExecutionState[]> {
  try {
    const conditions = [eq(workflowExecutions.userId, userId)];

    if (options?.driveId) {
      conditions.push(eq(workflowExecutions.driveId, options.driveId));
    }

    if (options?.status) {
      conditions.push(eq(workflowExecutions.status, options.status));
    }

    const executions = await db.query.workflowExecutions.findMany({
      where: and(...conditions),
      orderBy: [desc(workflowExecutions.startedAt)],
      limit: options?.limit || 50,
      with: {
        template: {
          columns: {
            id: true,
            name: true,
            description: true,
          },
        },
      },
    });

    // Get full state for each execution
    const states = await Promise.all(
      executions.map(execution => getExecutionState(execution.id))
    );

    return states.filter((state): state is ExecutionState => state !== null);
  } catch (error) {
    loggers.api.error('Error listing user executions:', error as Error);
    return [];
  }
}
