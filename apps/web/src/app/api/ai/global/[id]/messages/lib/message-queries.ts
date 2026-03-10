import { db, conversations, messages, drives, eq, and, desc, gt, lt } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { NextResponse } from 'next/server';
import {
  convertGlobalAssistantMessageToUIMessage,
  extractMessageContent,
  processMentionsInMessage,
  buildMentionSystemPrompt,
  saveGlobalAssistantMessageToDatabase,
  sanitizeMessagesForModel,
} from '@/lib/ai/core';
import { createId } from '@paralleldrive/cuid2';
import { convertToModelMessages, type UIMessage } from 'ai';
import type { GetRequestPagination, MentionProcessingResult, ValidatedContext } from './types';

const MAX_MESSAGES_WITH_IMAGES = 10;

export async function getConversation(
  conversationId: string,
  userId: string
): Promise<ValidatedContext['conversation'] | null> {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(
      eq(conversations.id, conversationId),
      eq(conversations.userId, userId),
      eq(conversations.isActive, true)
    ));

  return conversation ?? null;
}

export async function getMessagesPaginated(
  conversationId: string,
  pagination: GetRequestPagination
): Promise<{
  messages: UIMessage[];
  hasMore: boolean;
  nextCursor: string | null;
  prevCursor: string | null;
}> {
  const { limit, cursor, direction } = pagination;

  const conditions = [
    eq(messages.conversationId, conversationId),
    eq(messages.isActive, true)
  ];

  if (cursor) {
    const [cursorMessage] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, cursor))
      .limit(1);

    if (cursorMessage) {
      if (direction === 'before') {
        conditions.push(lt(messages.createdAt, cursorMessage.createdAt));
      } else {
        conditions.push(gt(messages.createdAt, cursorMessage.createdAt));
      }
    }
  }

  const conversationMessages = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit + 1);

  const hasMore = conversationMessages.length > limit;
  const messagesToReturn = hasMore ? conversationMessages.slice(0, limit) : conversationMessages;
  const orderedMessages = messagesToReturn.reverse();

  const uiMessages = orderedMessages.map(msg =>
    convertGlobalAssistantMessageToUIMessage({
      id: msg.id,
      conversationId: msg.conversationId,
      userId: msg.userId,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls,
      toolResults: msg.toolResults,
      createdAt: msg.createdAt,
      isActive: msg.isActive,
      editedAt: msg.editedAt,
    })
  );

  const nextCursor = hasMore && orderedMessages.length > 0
    ? orderedMessages[0].id
    : null;

  const prevCursor = orderedMessages.length > 0
    ? orderedMessages[orderedMessages.length - 1].id
    : null;

  return { messages: uiMessages, hasMore, nextCursor, prevCursor };
}

interface DbMessage {
  id: string;
  conversationId: string;
  userId: string;
  role: string;
  content: string;
  toolCalls: unknown;
  toolResults: unknown;
  createdAt: Date;
  isActive: boolean;
  editedAt: Date | null;
}

interface ConversationHistoryResult {
  dbMessages: DbMessage[];
  uiMessages: UIMessage[];
  sanitizedMessages: UIMessage[];
  processedMessages: UIMessage[];
  modelMessages: ReturnType<typeof convertToModelMessages>;
}

export async function getConversationHistory(conversationId: string): Promise<ConversationHistoryResult> {
  const dbMessages = await db
    .select()
    .from(messages)
    .where(and(
      eq(messages.conversationId, conversationId),
      eq(messages.isActive, true)
    ))
    .orderBy(messages.createdAt);

  const uiMessages: UIMessage[] = dbMessages.map(msg =>
    convertGlobalAssistantMessageToUIMessage({
      id: msg.id,
      conversationId: msg.conversationId,
      userId: msg.userId,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls,
      toolResults: msg.toolResults,
      createdAt: msg.createdAt,
      isActive: msg.isActive,
      editedAt: msg.editedAt,
    })
  );

  const sanitizedMessages = sanitizeMessagesForModel(uiMessages);
  const recentMessages = sanitizedMessages.slice(-MAX_MESSAGES_WITH_IMAGES);

  const processedMessages: UIMessage[] = recentMessages.map((msg: UIMessage) => {
    if (msg.role === 'assistant' && msg.parts) {
      const toolResults = msg.parts.filter((part: UIMessage['parts'][number]) => {
        if (part && typeof part === 'object' && 'type' in part && part.type === 'tool-result') {
          const result = (part as { result?: unknown }).result;
          if (result && typeof result === 'object' && 'type' in result && 'imageDataUrl' in result) {
            return (result as { type: string }).type === 'visual_content';
          }
        }
        return false;
      });

      if (toolResults.length > 0) {
        const newParts = [...msg.parts];

        toolResults.forEach((toolResult: UIMessage['parts'][number]) => {
          const result = (toolResult as { result?: { imageDataUrl?: string; title?: string } }).result;
          if (result?.imageDataUrl) {
            newParts.push({
              type: 'data-visual-content' as const,
              data: {
                imageDataUrl: result.imageDataUrl,
                title: result.title || 'Visual content'
              }
            } as UIMessage['parts'][number]);

            const mutableResult = result as { imageDataUrl?: string; title?: string };
            delete mutableResult.imageDataUrl;
          }
        });

        return { ...msg, parts: newParts };
      }
    }
    return msg;
  });

  const modelMessages = convertToModelMessages(processedMessages);

  return {
    dbMessages,
    uiMessages,
    sanitizedMessages,
    processedMessages,
    modelMessages,
  };
}

export async function processUserMessage(
  userMessage: UIMessage,
  conversationId: string,
  userId: string,
  conversation: ValidatedContext['conversation']
): Promise<MentionProcessingResult | Response> {
  try {
    const messageId = userMessage.id || createId();
    const messageContent = extractMessageContent(userMessage);

    const processedMessage = processMentionsInMessage(messageContent);
    const mentionedPageIds = processedMessage.pageIds;

    let mentionSystemPrompt = '';
    if (processedMessage.mentions.length > 0) {
      mentionSystemPrompt = buildMentionSystemPrompt(processedMessage.mentions);
      loggers.api.info('Global Assistant Chat API: Found @mentions in user message', {
        mentionCount: processedMessage.mentions.length,
        pageIds: mentionedPageIds
      });
    }

    loggers.api.debug('Global Assistant Chat API: Saving user message immediately', {
      id: messageId,
      contentLength: messageContent.length
    });

    await saveGlobalAssistantMessageToDatabase({
      messageId,
      conversationId,
      userId,
      role: 'user',
      content: messageContent,
      toolCalls: undefined,
      toolResults: undefined,
      uiMessage: userMessage,
    });

    const updateData: {
      lastMessageAt: Date;
      updatedAt: Date;
      title?: string;
    } = {
      lastMessageAt: new Date(),
      updatedAt: new Date(),
    };

    if (!conversation.title) {
      const title = messageContent.slice(0, 50) + (messageContent.length > 50 ? '...' : '');
      updateData.title = title;
    }

    await db
      .update(conversations)
      .set(updateData)
      .where(eq(conversations.id, conversationId));

    loggers.api.debug('Global Assistant Chat API: User message saved to database', {});

    return { mentionSystemPrompt, mentionedPageIds };
  } catch (error) {
    loggers.api.error('Global Assistant Chat API: Failed to save user message', error as Error);
    return NextResponse.json({
      error: 'Failed to save message to database',
      details: error instanceof Error ? error.message : 'Unknown database error',
      userMessage
    }, { status: 500 });
  }
}

export async function getDrivePrompt(driveId: string): Promise<string> {
  try {
    const [drive] = await db
      .select({ drivePrompt: drives.drivePrompt })
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive?.drivePrompt?.trim()) {
      loggers.api.debug('Global Assistant Chat API: Including drive prompt', {
        driveId,
        promptLength: drive.drivePrompt.length
      });
      return `\n\n## DRIVE INSTRUCTIONS\n\nThe following custom instructions have been set for this drive by the drive owner:\n\n${drive.drivePrompt}`;
    }
  } catch (error) {
    loggers.api.error('Global Assistant Chat API: Failed to fetch drive prompt', error as Error);
  }
  return '';
}

export async function updateConversationTimestamp(conversationId: string): Promise<void> {
  await db
    .update(conversations)
    .set({
      lastMessageAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));
}

export async function saveAssistantMessage(
  messageId: string,
  conversationId: string,
  userId: string,
  responseMessage: UIMessage,
  extractMessageContent: (msg: UIMessage) => string,
  extractToolCalls: (msg: UIMessage) => unknown[],
  extractToolResults: (msg: UIMessage) => unknown[]
): Promise<void> {
  const messageContent = extractMessageContent(responseMessage);
  const toolCalls = extractToolCalls(responseMessage);
  const toolResults = extractToolResults(responseMessage);

  await saveGlobalAssistantMessageToDatabase({
    messageId,
    conversationId,
    userId,
    role: 'assistant',
    content: messageContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    toolResults: toolResults.length > 0 ? toolResults : undefined,
    uiMessage: responseMessage,
  });

  await updateConversationTimestamp(conversationId);
}
