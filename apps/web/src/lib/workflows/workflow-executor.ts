import { convertToModelMessages, generateText, stepCountIs, hasToolCall } from 'ai';
import { finishTool, FINISH_TOOL_NAME } from '@/lib/ai/tools/finish-tool';
import { createId } from '@paralleldrive/cuid2';
import {
  createAIProvider,
  isProviderError,
  pageSpaceTools,
  buildTimestampSystemPrompt,
  type ToolExecutionContext,
  type ProviderRequest,
} from '@/lib/ai/core';
import { saveMessageToDatabase } from '@/lib/ai/core/message-utils';
import { AIMonitoring } from '@pagespace/lib/ai-monitoring';
import { db, pages, drives, eq, and, inArray, workflows as workflowsTable } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

export interface WorkflowExecutionResult {
  success: boolean;
  responseText?: string;
  toolCallCount?: number;
  durationMs: number;
  error?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

type WorkflowRow = typeof workflowsTable.$inferSelect;

export async function executeWorkflow(workflow: WorkflowRow): Promise<WorkflowExecutionResult> {
  const startTime = Date.now();

  try {
    // 1. Load agent page
    const [agent] = await db
      .select()
      .from(pages)
      .where(eq(pages.id, workflow.agentPageId));

    if (!agent) {
      return { success: false, durationMs: Date.now() - startTime, error: 'Agent page not found' };
    }
    if (agent.type !== 'AI_CHAT') {
      return { success: false, durationMs: Date.now() - startTime, error: 'Agent page is not an AI_CHAT type' };
    }
    if (agent.isTrashed) {
      return { success: false, durationMs: Date.now() - startTime, error: 'Agent page is in trash' };
    }

    // 2. Load drive
    const [drive] = await db
      .select()
      .from(drives)
      .where(eq(drives.id, workflow.driveId));

    if (!drive) {
      return { success: false, durationMs: Date.now() - startTime, error: 'Drive not found' };
    }

    // 3. Build system prompt
    const systemPrompt = agent.systemPrompt || 'You are a helpful AI assistant.';
    let enhancedSystemPrompt = systemPrompt;

    if (agent.includeDrivePrompt && drive.drivePrompt) {
      enhancedSystemPrompt += `\n\n${drive.drivePrompt}`;
    }

    enhancedSystemPrompt += `\n\n${buildTimestampSystemPrompt(workflow.timezone)}`;

    enhancedSystemPrompt += `\n\nCONTEXT AWARENESS:\n`;
    enhancedSystemPrompt += `- Current Drive: ${drive.name} (${drive.slug})\n`;
    enhancedSystemPrompt += `- Drive ID: ${drive.id}\n`;
    enhancedSystemPrompt += `\nYou are operating within this drive. Use this drive ID (${drive.id}) as the default when using tools like list_pages, create_page, etc. unless explicitly told otherwise.`;
    enhancedSystemPrompt += `\n\nThis is an automated workflow execution. Execute the requested task thoroughly and completely.`;

    // 4. Build user message with context documents
    let userMessage = workflow.prompt;

    const contextPageIds = (workflow.contextPageIds as string[] | null) ?? [];
    if (contextPageIds.length > 0) {
      const validContextPages = await db
        .select({ id: pages.id, title: pages.title, content: pages.content })
        .from(pages)
        .where(
          and(
            inArray(pages.id, contextPageIds),
            eq(pages.driveId, workflow.driveId),
            eq(pages.isTrashed, false)
          )
        );

      if (validContextPages.length > 0) {
        userMessage += '\n\n--- Reference Documents ---';
        for (const page of validContextPages) {
          userMessage += `\n\n## ${page.title}\n${page.content || '(empty)'}`;
        }
      }
    }

    // 5. Resolve AI provider using workflow creator's keys
    const selectedProvider = agent.aiProvider || 'pagespace';
    const selectedModel = agent.aiModel || (selectedProvider === 'pagespace' ? 'glm-4.5-air' : undefined);

    const providerRequest: ProviderRequest = {
      selectedProvider,
      selectedModel,
    };

    const providerResult = await createAIProvider(workflow.createdBy, providerRequest);

    if (isProviderError(providerResult)) {
      return { success: false, durationMs: Date.now() - startTime, error: `AI provider error: ${providerResult.error}` };
    }

    // 6. Filter tools based on agent's enabled tools
    const enabledTools = (agent.enabledTools as string[] | null) ?? [];
    const availableTools = enabledTools.length > 0
      ? Object.fromEntries(
          Object.entries(pageSpaceTools).filter(([toolName]) =>
            enabledTools.includes(toolName)
          )
        )
      : {};

    // 7. Build execution context
    const conversationId = `workflow-${workflow.id}-${Date.now()}`;
    const executionContext: ToolExecutionContext = {
      userId: workflow.createdBy,
      timezone: workflow.timezone,
      aiProvider: agent.aiProvider ?? undefined,
      aiModel: agent.aiModel ?? undefined,
      conversationId,
      locationContext: {
        currentPage: {
          id: agent.id,
          title: agent.title,
          type: agent.type,
          path: `/${agent.title}`,
        },
        currentDrive: {
          id: drive.id,
          name: drive.name,
          slug: drive.slug,
        },
      },
    };

    const messages = [{ role: 'user' as const, content: userMessage }];

    // 8. Call generateText
    const result = Object.keys(availableTools).length > 0
      ? await generateText({
          model: providerResult.model,
          system: enhancedSystemPrompt,
          messages: convertToModelMessages(messages.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
            parts: [{ type: 'text' as const, text: m.content }],
          }))),
          tools: { ...availableTools, ...finishTool },
          toolChoice: 'auto',
          temperature: 0.7,
          maxRetries: 3,
          experimental_context: executionContext,
          stopWhen: [hasToolCall(FINISH_TOOL_NAME), stepCountIs(100)],
        })
      : await generateText({
          model: providerResult.model,
          system: enhancedSystemPrompt,
          messages: convertToModelMessages(messages.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
            parts: [{ type: 'text' as const, text: m.content }],
          }))),
          temperature: 0.7,
          maxRetries: 3,
          experimental_context: executionContext,
          stopWhen: stepCountIs(100),
        });

    // Collect text from all steps — result.text only returns the final step,
    // which may be empty if the model's last action was calling the finish tool
    const responseText = result.steps?.map(s => s.text).filter(Boolean).join('') || '';
    const toolCallCount = result.steps?.reduce(
      (count, step) => count + (step.toolCalls?.length || 0),
      0
    ) || 0;

    // 9. Save user prompt + AI response as chat messages
    const userMessageId = createId();
    const assistantMessageId = createId();

    await saveMessageToDatabase({
      messageId: userMessageId,
      pageId: agent.id,
      conversationId,
      userId: workflow.createdBy,
      role: 'user',
      content: userMessage,
    });

    await saveMessageToDatabase({
      messageId: assistantMessageId,
      pageId: agent.id,
      conversationId,
      userId: null,
      role: 'assistant',
      content: responseText,
    });

    // 10. Track usage
    const usage = result.usage;
    AIMonitoring.trackUsage({
      userId: workflow.createdBy,
      provider: providerResult.provider,
      model: providerResult.modelName,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      totalTokens: usage ? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) : undefined,
      pageId: agent.id,
      driveId: workflow.driveId,
      success: true,
    });

    const durationMs = Date.now() - startTime;

    loggers.api.info('Workflow executed successfully', {
      workflowId: workflow.id,
      workflowName: workflow.name,
      agentId: agent.id,
      agentTitle: agent.title,
      responseLength: responseText.length,
      toolCallCount,
      durationMs,
    });

    return {
      success: true,
      responseText,
      toolCallCount,
      durationMs,
      usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : undefined,
    };

  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    loggers.api.error('Workflow execution failed', {
      workflowId: workflow.id,
      error: errorMessage,
      durationMs,
    });

    return {
      success: false,
      durationMs,
      error: errorMessage,
    };
  }
}
