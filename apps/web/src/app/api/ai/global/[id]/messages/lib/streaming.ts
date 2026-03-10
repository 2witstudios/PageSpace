import { streamText, stepCountIs, type LanguageModel } from 'ai';
import { createId } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';
import { getModelCapabilities } from '@/lib/ai/core';
import {
  createStreamAbortController,
  removeStream,
} from '@/lib/ai/core/stream-abort-registry';
import type { ToolSet, LocationContext } from './types';

export interface StreamParams {
  model: LanguageModel;
  provider: string;
  modelName: string;
  userId: string;
  conversationId: string;
  userTimezone: string;
  locationContext?: LocationContext;
  systemPrompt: string;
  messages: Parameters<typeof streamText>[0]['messages'];
  tools: ToolSet;
  readOnlyMode: boolean;
}

export interface StreamResult {
  streamId: string;
  serverAssistantMessageId: string;
  aiResult: ReturnType<typeof streamText>;
}

export function prepareStream(params: StreamParams): StreamResult {
  const {
    model,
    provider,
    modelName,
    userId,
    conversationId,
    userTimezone,
    locationContext,
    systemPrompt,
    messages,
    tools,
    readOnlyMode,
  } = params;

  const { streamId, signal: abortSignal } = createStreamAbortController({ userId });
  const serverAssistantMessageId = createId();

  const modelCapabilities = getModelCapabilities(modelName, provider);

  loggers.api.debug('Global Assistant Chat API: Starting streamText', {
    model: modelName,
    isReadOnly: readOnlyMode
  });

  const aiResult = streamText({
    model,
    system: systemPrompt,
    messages,
    tools,
    stopWhen: stepCountIs(100),
    abortSignal,
    experimental_context: {
      userId,
      timezone: userTimezone,
      aiProvider: provider,
      aiModel: modelName,
      conversationId,
      locationContext,
      modelCapabilities,
      chatSource: { type: 'global' as const },
    },
    maxRetries: 20,
    onAbort: () => {
      loggers.api.info('Global Assistant Chat API: Stream aborted by user', {
        userId: maskIdentifier(userId),
        conversationId,
        streamId,
        model: modelName,
        provider,
      });
    },
  });

  return {
    streamId,
    serverAssistantMessageId,
    aiResult,
  };
}

export function cleanupStream(streamId: string): void {
  removeStream({ streamId });
}
