import { NextResponse } from 'next/server';
import { streamText, convertToModelMessages } from 'ai';
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
import { loggers } from '@pagespace/lib/logger-config';

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

    // Build conversation messages
    const conversationMessages = [];

    // Add system prompt with timestamp
    const timestampPrompt = buildTimestampSystemPrompt();
    conversationMessages.push({
      role: 'system',
      content: `${systemPrompt}\n\n${timestampPrompt}`
    });

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
      const result = await streamText({
        model,
        messages: convertToModelMessages(conversationMessages.map(m => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content,
          parts: [{ type: 'text', text: m.content }]
        }))),
        tools: availableTools,
        toolChoice: 'auto',
        temperature: 0.7,
      });

      // Collect the full response
      for await (const delta of result.textStream) {
        responseText += delta;
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