import { NextResponse } from 'next/server';
import { convertToModelMessages, generateText, stepCountIs } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createXai } from '@ai-sdk/xai';
import { createOllama } from 'ollama-ai-provider-v2';
import { authenticateMCPRequest, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import {
  getUserOpenRouterSettings,
  getUserGoogleSettings,
  getDefaultPageSpaceSettings,
  getUserOpenAISettings,
  getUserAnthropicSettings,
  getUserXAISettings,
  getUserOllamaSettings
} from '@/lib/ai/ai-utils';
import { db, pages, eq, chatMessages } from '@pagespace/db';
import { pageSpaceTools } from '@/lib/ai/ai-tools';
import { buildTimestampSystemPrompt } from '@/lib/ai/timestamp-utils';
import { ToolExecutionContext } from '@/lib/ai/types';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * Format tool execution results into human-readable text
 */
function formatToolExecutionResults(steps: unknown[]): string {
  const toolResults: string[] = [];

  steps.forEach((step) => {
    // Type guard for step structure
    if (typeof step === 'object' && step !== null) {
      const stepObj = step as Record<string, unknown>;

      if (Array.isArray(stepObj.toolCalls) && stepObj.toolCalls.length > 0) {
        stepObj.toolCalls.forEach((toolCall: unknown, callIndex: number) => {
          // Type guard for toolCall structure
          if (typeof toolCall === 'object' && toolCall !== null) {
            const toolCallObj = toolCall as Record<string, unknown>;
            const toolResults = Array.isArray(stepObj.toolResults) ? stepObj.toolResults : [];
            const toolResult = toolResults[callIndex];

            // Format tool execution details
            let resultText = `**Tool Used: ${toolCallObj.toolName || 'Unknown Tool'}**`;

            // Add arguments if they exist and are meaningful
            if (typeof toolCallObj.args === 'object' && toolCallObj.args !== null) {
              const argKeys = Object.keys(toolCallObj.args);
              if (argKeys.length <= 3) {
                // Show compact args for simple calls
                resultText += `\nArguments: ${JSON.stringify(toolCallObj.args)}`;
              } else {
                // Show summary for complex calls
                resultText += `\nArguments: ${argKeys.length} parameters provided`;
              }
            }

            // Add tool result/output
            if (typeof toolResult === 'object' && toolResult !== null) {
              const toolResultObj = toolResult as Record<string, unknown>;
              if (toolResultObj.result) {
                if (typeof toolResultObj.result === 'string') {
                  // String results - truncate if very long
                  const resultStr = toolResultObj.result.length > 500
                    ? toolResultObj.result.substring(0, 500) + '...'
                    : toolResultObj.result;
                  resultText += `\nResult: ${resultStr}`;
                } else if (typeof toolResultObj.result === 'object' && toolResultObj.result !== null) {
                  // Object results - show summary or key fields
                  const resultData = toolResultObj.result as Record<string, unknown>;
                  if (resultData.success !== undefined) {
                    resultText += `\nResult: ${resultData.success ? 'Success' : 'Failed'}`;
                    if (typeof resultData.message === 'string') {
                      resultText += ` - ${resultData.message}`;
                    }
                    if (typeof resultData.summary === 'string') {
                      resultText += ` (${resultData.summary})`;
                    }
                  } else {
                    resultText += `\nResult: ${JSON.stringify(toolResultObj.result, null, 2)}`;
                  }
                }
              }
            } else {
              resultText += '\nResult: Tool executed successfully';
            }

            toolResults.push(resultText);
          }
        });
      }

      // Also check for text content in steps that might contain tool output descriptions
      if (Array.isArray(stepObj.content)) {
        stepObj.content.forEach((contentPart: unknown) => {
          if (typeof contentPart === 'object' && contentPart !== null) {
            const contentPartObj = contentPart as Record<string, unknown>;
            if (contentPartObj.type === 'text' && typeof contentPartObj.text === 'string' && contentPartObj.text.trim()) {
              // Only include if it's not just whitespace and adds meaningful info
              const text = contentPartObj.text.trim();
              if (text.length > 10 && !text.match(/^(I'll|Let me|I'm going to)/)) {
                toolResults.push(`**Generated Text**: ${text}`);
              }
            }
          }
        });
      }
    }
  });

  return toolResults.length > 0
    ? `\n\n--- Tool Execution Results ---\n${toolResults.join('\n\n')}`
    : '';
}

/**
 * Get configured AI model for agent
 */
async function getConfiguredModel(userId: string, agentConfig: { aiProvider?: string | null; aiModel?: string | null }) {
  const { aiProvider, aiModel } = agentConfig;

  switch (aiProvider) {
    case 'openrouter': {
      const settings = await getUserOpenRouterSettings(userId);
      const defaultSettings = await getDefaultPageSpaceSettings();
      const apiKey = settings?.apiKey || (defaultSettings?.provider === 'openrouter' ? defaultSettings.apiKey : undefined);
      if (!apiKey) throw new Error('OpenRouter API key not configured');
      const openrouter = createOpenRouter({ apiKey });
      return openrouter(aiModel || 'anthropic/claude-3.5-sonnet');
    }

    case 'google': {
      const settings = await getUserGoogleSettings(userId);
      const defaultSettings = await getDefaultPageSpaceSettings();
      const apiKey = settings?.apiKey || (defaultSettings?.provider === 'google' ? defaultSettings.apiKey : undefined);
      if (!apiKey) throw new Error('Google AI API key not configured');
      const google = createGoogleGenerativeAI({ apiKey });
      return google(aiModel || 'gemini-2.5-flash');
    }

    case 'openai': {
      const settings = await getUserOpenAISettings(userId);
      const apiKey = settings?.apiKey;
      if (!apiKey) throw new Error('OpenAI API key not configured');
      const openai = createOpenAI({ apiKey });
      return openai(aiModel || 'gpt-4');
    }

    case 'anthropic': {
      const settings = await getUserAnthropicSettings(userId);
      const apiKey = settings?.apiKey;
      if (!apiKey) throw new Error('Anthropic API key not configured');
      const anthropic = createAnthropic({ apiKey });
      return anthropic(aiModel || 'claude-3-5-sonnet-20241022');
    }

    case 'xai': {
      const settings = await getUserXAISettings(userId);
      const apiKey = settings?.apiKey;
      if (!apiKey) throw new Error('xAI API key not configured');
      const xai = createXai({ apiKey });
      return xai(aiModel || 'grok-beta');
    }

    case 'ollama': {
      const settings = await getUserOllamaSettings(userId);
      const baseURL = settings?.baseUrl || 'http://localhost:11434';
      const ollama = createOllama({ baseURL });
      return ollama(aiModel || 'llama3.1');
    }

    default: {
      // Fall back to default PageSpace settings
      const defaultSettings = await getDefaultPageSpaceSettings();
      if (!defaultSettings) {
        throw new Error('No AI provider configured');
      }

      // Only use Google AI as the default provider
      if (defaultSettings.provider === 'google') {
        const google = createGoogleGenerativeAI({ apiKey: defaultSettings.apiKey });
        return google('gemini-2.5-flash');
      }

      // Should not reach here if properly configured, but throw clear error
      throw new Error('Default AI provider must be Google AI with gemini-2.5-flash');
    }
  }
}

/**
 * POST /api/agents/consult
 * Consult another AI agent in the workspace for specialized knowledge or assistance
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateMCPRequest(request);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const body = await request.json();
    const { agentId, question, context } = body;

    if (!agentId || !question) {
      return NextResponse.json(
        { error: 'agentId and question are required' },
        { status: 400 }
      );
    }

    // Get the agent page and verify it exists
    const [agent] = await db
      .select()
      .from(pages)
      .where(eq(pages.id, agentId));

    if (!agent) {
      return NextResponse.json(
        { error: `Agent with ID "${agentId}" not found` },
        { status: 404 }
      );
    }

    // Verify it's an AI_CHAT page
    if (agent.type !== 'AI_CHAT') {
      return NextResponse.json(
        { error: `Page "${agentId}" is not an AI agent` },
        { status: 400 }
      );
    }

    // Check view permissions
    const canView = await canUserViewPage(userId, agentId);
    if (!canView) {
      return NextResponse.json(
        { error: 'Insufficient permissions to consult this agent' },
        { status: 403 }
      );
    }

    // Get agent configuration
    const systemPrompt = agent.systemPrompt || 'You are a helpful AI assistant.';
    const enabledTools = agent.enabledTools || [];

    // Get recent conversation history for context (last 10 messages)
    const recentMessages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.pageId, agentId))
      .orderBy(chatMessages.createdAt)
      .limit(10);

    // Build conversation messages (exclude system - handled separately)
    const conversationMessages = [];

    // Add recent conversation context if available
    for (const msg of recentMessages) {
      if (msg.content) {
        conversationMessages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    // Add the consultation question with context
    const consultationMessage = context
      ? `Context: ${context}\n\nQuestion: ${question}`
      : question;

    conversationMessages.push({
      role: 'user',
      content: consultationMessage
    });

    // Get configured AI model for agent
    let model;
    try {
      model = await getConfiguredModel(userId, {
        aiProvider: agent.aiProvider,
        aiModel: agent.aiModel
      });
    } catch (providerError) {
      loggers.api.error('Agent consultation provider setup error:', providerError as Error);
      return NextResponse.json(
        { error: `Failed to configure AI provider: ${providerError instanceof Error ? providerError.message : String(providerError)}` },
        { status: 500 }
      );
    }

    // Build execution context for tool execution
    const executionContext: ToolExecutionContext = {
      userId,
      conversationId: `agent-consult-${agentId}-${Date.now()}`,
      locationContext: {
        currentPage: {
          id: agent.id,
          title: agent.title,
          type: agent.type,
          path: `/${agent.title}` // Simplified path
        }
      }
    };

    // Filter tools based on agent's enabled tools
    const availableTools = Array.isArray(enabledTools) && enabledTools.length > 0
      ? Object.fromEntries(
          Object.entries(pageSpaceTools).filter(([toolName]) =>
            enabledTools.includes(toolName)
          )
        )
      : {};

    // Generate response using the AI model
    let responseText = '';
    try {
      loggers.api.debug('Starting agent consultation with tools', {
        agentId,
        agentTitle: agent.title,
        toolsEnabled: Array.isArray(enabledTools) ? enabledTools.length : 0,
        availableToolsCount: Object.keys(availableTools).length,
        enabledToolsList: enabledTools
      });

      const result = Object.keys(availableTools).length > 0
        ? await generateText({
            model,
            system: `${systemPrompt}\n\n${buildTimestampSystemPrompt()}`,
            messages: convertToModelMessages(conversationMessages.filter(m => m.role !== 'system').map(m => ({
              role: m.role as 'user' | 'assistant' | 'system',
              content: m.content,
              parts: [{ type: 'text', text: m.content }]
            }))),
            tools: availableTools,
            toolChoice: 'auto',
            temperature: 0.7,
            maxRetries: 3,
            experimental_context: executionContext,
            stopWhen: stepCountIs(100), // Match AI SDK version
            onStepFinish: ({ toolCalls, toolResults, text }) => {
              loggers.api.debug('Agent tool execution step completed', {
                agentId,
                toolCallsCount: toolCalls?.length || 0,
                toolCallNames: toolCalls?.map(tc => tc.toolName) || [],
                toolResultsCount: toolResults?.length || 0,
                stepText: text?.substring(0, 100) || 'No text'
              });
            }
          })
        : await generateText({
            model,
            system: `${systemPrompt}\n\n${buildTimestampSystemPrompt()}`,
            messages: convertToModelMessages(conversationMessages.filter(m => m.role !== 'system').map(m => ({
              role: m.role as 'user' | 'assistant' | 'system',
              content: m.content,
              parts: [{ type: 'text', text: m.content }]
            }))),
            temperature: 0.7,
            maxRetries: 3,
            experimental_context: executionContext,
            stopWhen: stepCountIs(100), // Match AI SDK version
          });

      // Enhanced debugging: Log the complete result structure
      loggers.api.debug('Agent consultation result structure', {
        agentId,
        hasText: !!result.text,
        textLength: result.text?.length || 0,
        textPreview: result.text?.substring(0, 100) || 'No text',
        hasSteps: !!result.steps,
        stepsCount: result.steps?.length || 0,
        stepsStructure: result.steps?.map((step, i) => ({
          stepIndex: i,
          hasToolCalls: !!step.toolCalls,
          toolCallsCount: step.toolCalls?.length || 0,
          hasToolResults: !!step.toolResults,
          toolResultsCount: step.toolResults?.length || 0,
          hasContent: !!step.content,
          contentPartsCount: step.content?.length || 0
        })) || []
      });

      // Extract response text with tool execution results
      responseText = result.text;

      // Enhanced: Include tool execution results for complete MCP responses
      if (result.steps && result.steps.length > 0) {
        loggers.api.debug('Processing tool execution results', {
          agentId,
          stepsCount: result.steps.length,
          originalTextLength: result.text?.length || 0
        });

        const toolExecutionSummary = formatToolExecutionResults(result.steps);

        loggers.api.debug('Tool execution summary generated', {
          agentId,
          summaryLength: toolExecutionSummary?.length || 0,
          summaryPreview: toolExecutionSummary?.substring(0, 200) || 'No summary generated'
        });

        if (toolExecutionSummary) {
          responseText = responseText
            ? `${responseText}${toolExecutionSummary}`
            : toolExecutionSummary.replace(/^\n\n/, ''); // Remove leading newlines if no initial text

          loggers.api.info('Enhanced agent response with tool execution results', {
            agentId,
            originalTextLength: result.text?.length || 0,
            enhancedTextLength: responseText.length,
            toolSteps: result.steps.length,
            finalResponsePreview: responseText.substring(0, 300)
          });
        } else {
          loggers.api.warn('No tool execution summary generated despite having steps', {
            agentId,
            stepsCount: result.steps.length,
            stepsPreview: result.steps.map(step => ({
              hasToolCalls: !!step.toolCalls,
              toolCallsCount: step.toolCalls?.length || 0,
              hasToolResults: !!step.toolResults,
              hasContent: !!step.content
            }))
          });
        }
      } else {
        loggers.api.debug('No tool execution steps found', {
          agentId,
          hasSteps: !!result.steps,
          stepsCount: result.steps?.length || 0,
          originalTextLength: result.text?.length || 0
        });
      }

      // Check for tool execution errors
      const toolErrors = result.steps?.flatMap(step =>
        step.content?.filter(part => part.type === 'tool-error') || []
      ) || [];

      if (toolErrors.length > 0) {
        loggers.api.warn('Agent consultation tool execution errors:', {
          agentId,
          errors: toolErrors,
        });
      }
    } catch (aiError) {
      loggers.api.error('Agent consultation AI generation error:', aiError as Error);
      return NextResponse.json(
        { error: `Failed to generate response from agent: ${aiError instanceof Error ? aiError.message : String(aiError)}` },
        { status: 500 }
      );
    }

    loggers.api.info('Agent consultation completed', {
      agentId,
      agentTitle: agent.title,
      questionLength: question.length,
      responseLength: responseText.length,
      userId
    });

    return NextResponse.json({
      success: true,
      agent: {
        id: agent.id,
        title: agent.title,
        systemPrompt: systemPrompt.substring(0, 100) + (systemPrompt.length > 100 ? '...' : ''),
        provider: agent.aiProvider || 'default',
        model: agent.aiModel || 'default',
        enabledToolsCount: Array.isArray(enabledTools) ? enabledTools.length : 0
      },
      question,
      response: responseText,
      context: context || null,
      metadata: {
        conversationLength: recentMessages.length,
        toolsAvailable: Array.isArray(enabledTools) ? enabledTools.length : 0,
        provider: agent.aiProvider || 'default',
        model: agent.aiModel || 'default',
        responseLength: responseText.length,
        timestamp: new Date().toISOString()
      },
      summary: `Consulted agent "${agent.title}" and received ${responseText.length} character response`,
      nextSteps: [
        'Review the agent\'s response for insights',
        'Continue the conversation if needed using the agent\'s page',
        'Consider adjusting the agent\'s configuration if the response wasn\'t helpful',
        `Agent: ${agent.title} (${agent.id})`
      ]
    });

  } catch (error) {
    loggers.api.error('Error during agent consultation:', error as Error);
    return NextResponse.json(
      { error: `Failed to consult agent: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}