import { UIMessage } from 'ai';
import { db, chatMessages, messages } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

/**
 * Assistant utilities for AI tool calling and message handling
 * Provides helper functions for tool execution, permission checking, and message conversion
 */

/**
 * Safe debug logging utilities for AI content
 * Prevents sensitive user content from being logged while maintaining operational visibility
 */
const isAIDebugEnabled = process.env.AI_DEBUG_LOGGING === 'true';

function createContentMetadata(content: string): object {
  return {
    length: content.length,
    hasContent: content.length > 0,
    isEmpty: content.trim() === '',
    preview: content.length > 0 ? `[CONTENT_REDACTED:${content.length}chars]` : '[EMPTY]'
  };
}

function debugLogAI(message: string, data?: object): void {
  if (isAIDebugEnabled) {
    loggers.ai.debug(message, data);
  }
}

interface ToolCall {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
}

interface ToolResult {
  toolCallId: string;
  toolName: string;
  output: unknown;
  state: 'output-available' | 'output-error';
}

interface TextPart {
  type: 'text';
  text: string;
}

interface ToolPart {
  type: string; // "tool-{toolName}"
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
}

interface DatabaseMessage {
  id: string;
  pageId: string;
  userId: string | null;
  role: string;
  content: string;
  toolCalls: unknown;
  toolResults: unknown;
  createdAt: Date;
  isActive: boolean;
  editedAt?: Date | null;
  messageType?: 'standard' | 'todo_list';
}


interface GlobalAssistantMessage {
  id: string;
  conversationId: string;
  userId: string;
  role: string;
  content: string;
  toolCalls: unknown;
  toolResults: unknown;
  createdAt: Date;
  isActive: boolean;
  editedAt?: Date | null;
  messageType?: 'standard' | 'todo_list';
}

/**
 * Extract text content from UIMessage parts
 */
export function extractMessageContent(message: UIMessage): string {
  if (!message.parts) {
    debugLogAI('extractMessageContent: No parts in message');
    return '';
  }

  debugLogAI('extractMessageContent: Message analysis', {
    partsCount: message.parts.length,
    partTypes: message.parts.map(p => p.type)
  });

  const textParts = message.parts.filter(part => part.type === 'text');
  debugLogAI('extractMessageContent: Text parts analysis', {
    textPartsFound: textParts.length
  });

  // Create safe metadata for each text part
  const textPartsMetadata = textParts.map((part, index) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (part as any).text || '';
    return {
      partIndex: index + 1,
      ...createContentMetadata(text)
    };
  });

  debugLogAI('extractMessageContent: Text parts metadata', {
    parts: textPartsMetadata
  });

  const textContent = textParts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map(part => (part as any).text || '')
    .filter(text => text.trim() !== '')
    .join('');

  debugLogAI('extractMessageContent: Final result', createContentMetadata(textContent));

  return textContent;
}

/**
 * Extract tool calls from UIMessage parts
 */
export function extractToolCalls(message: UIMessage): ToolCall[] {
  if (!message.parts) return [];
  
  return message.parts
    .filter(part => part.type.startsWith('tool-'))
    .map(part => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolPart = part as any;
      return {
        toolCallId: toolPart.toolCallId,
        toolName: toolPart.toolName || toolPart.type.replace('tool-', ''),
        input: toolPart.input || {},
        state: toolPart.state,
      };
    });
}

/**
 * Extract tool results from UIMessage parts
 */
export function extractToolResults(message: UIMessage): ToolResult[] {
  if (!message.parts) return [];
  
  return message.parts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter(part => part.type.startsWith('tool-') && (part as any).output !== undefined)
    .map(part => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolPart = part as any;
      return {
        toolCallId: toolPart.toolCallId,
        toolName: toolPart.toolName || toolPart.type.replace('tool-', ''),
        output: toolPart.output,
        state: toolPart.state as 'output-available' | 'output-error',
      };
    });
}

/**
 * Convert database message to UIMessage format with tool parts
 */
export function convertDbMessageToUIMessage(dbMessage: DatabaseMessage): UIMessage {
  // Parse structured content
  if (dbMessage.content) {
    try {
      const parsed = JSON.parse(dbMessage.content);
      if (parsed.textParts && parsed.partsOrder) {
        debugLogAI('Reconstructing message with structured content', {
          textPartsCount: parsed.textParts.length,
          totalPartsCount: parsed.partsOrder.length
        });

        return reconstructMessageFromStructuredContent(dbMessage, parsed);
      }
    } catch {
      // Content is plain text, not structured
      debugLogAI('Using plain text content for message', { messageId: dbMessage.id });
    }
  }

  // Simple text message
  return {
    id: dbMessage.id,
    role: dbMessage.role as 'user' | 'assistant' | 'system',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parts: [{ type: 'text', text: dbMessage.content || '' }] as any,
    createdAt: dbMessage.createdAt,
    editedAt: dbMessage.editedAt,
    messageType: dbMessage.messageType || 'standard',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * Reconstruct message from structured content (new format with chronological ordering)
 */
function reconstructMessageFromStructuredContent(
  dbMessage: DatabaseMessage, 
  structuredData: { textParts: string[]; partsOrder: Array<{ index: number; type: string; toolCallId?: string }>; originalContent?: string }
): UIMessage {
  const parts: Array<TextPart | ToolPart> = [];
  let textPartIndex = 0;
  
  // Parse tool calls and results for lookup
  const toolCallsMap = new Map<string, ToolCall>();
  const toolResultsMap = new Map<string, ToolResult>();
  
  if (dbMessage.toolCalls) {
    try {
      const toolCalls = typeof dbMessage.toolCalls === 'string' 
        ? JSON.parse(dbMessage.toolCalls) as ToolCall[]
        : Array.isArray(dbMessage.toolCalls) ? dbMessage.toolCalls as ToolCall[] : [];
      toolCalls.forEach(tc => toolCallsMap.set(tc.toolCallId, tc));
    } catch (error) {
      console.error('Error parsing tool calls:', error);
    }
  }
  
  if (dbMessage.toolResults) {
    try {
      const toolResults = typeof dbMessage.toolResults === 'string'
        ? JSON.parse(dbMessage.toolResults) as ToolResult[]
        : Array.isArray(dbMessage.toolResults) ? dbMessage.toolResults as ToolResult[] : [];
      toolResults.forEach(tr => toolResultsMap.set(tr.toolCallId, tr));
    } catch (error) {
      console.error('Error parsing tool results:', error);
    }
  }
  
  // Reconstruct parts in original order
  structuredData.partsOrder.forEach(partOrder => {
    if (partOrder.type === 'text') {
      if (textPartIndex < structuredData.textParts.length) {
        const textContent = structuredData.textParts[textPartIndex];
        if (textContent && textContent.trim()) {
          parts.push({
            type: 'text',
            text: textContent,
          });
        }
        textPartIndex++;
      }
    } else if (partOrder.type.startsWith('tool-') && partOrder.toolCallId) {
      const toolCall = toolCallsMap.get(partOrder.toolCallId);
      const toolResult = toolResultsMap.get(partOrder.toolCallId);
      
      if (toolCall) {
        parts.push({
          type: partOrder.type,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
          output: toolResult?.output,
          state: toolResult ? 'output-available' : 'input-available',
        });
      }
    } else if (partOrder.type === 'step-start') {
      // Skip step-start parts for now - they're AI SDK internal
    }
  });
  
  return {
    id: dbMessage.id,
    role: dbMessage.role as 'user' | 'assistant' | 'system',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parts: parts.length > 0 ? (parts as any) : [{ type: 'text', text: structuredData.originalContent || '' }],
    createdAt: dbMessage.createdAt,
    editedAt: dbMessage.editedAt,
    messageType: dbMessage.messageType || 'standard',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * Save a message with tool calls and results to the database
 * Supports both legacy format and new structured format with chronological ordering
 */
export async function saveMessageToDatabase({
  messageId,
  pageId,
  conversationId,
  userId,
  role,
  content,
  toolCalls,
  toolResults,
  uiMessage,
  sourceAgentId,
}: {
  messageId: string;
  pageId: string;
  conversationId: string; // Group messages into conversation sessions
  userId: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  uiMessage?: UIMessage; // Pass the complete UIMessage to preserve part ordering
  sourceAgentId?: string | null; // ID of the AI agent that sent this message (for agent-to-agent communication)
}) {
  try {
    let structuredContent = content;
    
    // If we have the complete UIMessage, store structured content to preserve chronological order
    if (uiMessage?.parts && uiMessage.parts.length > 0) {
      const textParts = uiMessage.parts
        .filter(p => p.type === 'text')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map(p => (p as any).text || '');
      
      const partsOrder = uiMessage.parts.map((p, i) => ({
        index: i,
        type: p.type,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolCallId: p.type.startsWith('tool-') ? (p as any).toolCallId : undefined
      }));
      
      structuredContent = JSON.stringify({
        textParts,
        partsOrder,
        originalContent: content, // Keep original for backward compatibility
      });
      
      debugLogAI('Saving structured content', {
        textPartsCount: textParts.length,
        totalPartsCount: partsOrder.length
      });
    }

    await db.insert(chatMessages)
      .values({
        id: messageId,
        pageId,
        conversationId, // Group messages into conversation sessions
        userId,
        role,
        content: structuredContent,
        toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
        toolResults: toolResults ? JSON.stringify(toolResults) : null,
        createdAt: new Date(),
        isActive: true,
        sourceAgentId: sourceAgentId ?? null, // Track which AI agent sent this message
      })
      .onConflictDoUpdate({
        target: chatMessages.id,
        set: {
          content: structuredContent,
          toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
          toolResults: toolResults ? JSON.stringify(toolResults) : null,
          conversationId, // Update conversationId if message is reprocessed
          sourceAgentId: sourceAgentId ?? null,
        }
      });
  } catch (error) {
    console.error('Error saving message to database:', error);
    throw error;
  }
}

/**
 * Convert Global Assistant database message to UIMessage format
 */
export function convertGlobalAssistantMessageToUIMessage(dbMessage: GlobalAssistantMessage): UIMessage {
  // Parse structured content
  if (dbMessage.content) {
    try {
      const parsed = JSON.parse(dbMessage.content);
      if (parsed.textParts && parsed.partsOrder) {
        debugLogAI('Global Assistant: Reconstructing message with structured content', {
          textPartsCount: parsed.textParts.length,
          totalPartsCount: parsed.partsOrder.length
        });

        return reconstructGlobalAssistantMessageFromStructuredContent(dbMessage, parsed);
      }
    } catch {
      // Content is plain text, not structured
      debugLogAI('Global Assistant: Using plain text content for message', { messageId: dbMessage.id });
    }
  }

  // Simple text message
  return {
    id: dbMessage.id,
    role: dbMessage.role as 'user' | 'assistant' | 'system',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parts: [{ type: 'text', text: dbMessage.content || '' }] as any,
    createdAt: dbMessage.createdAt,
    editedAt: dbMessage.editedAt,
    messageType: dbMessage.messageType || 'standard',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * Reconstruct Global Assistant message from structured content (new format with chronological ordering)
 */
function reconstructGlobalAssistantMessageFromStructuredContent(
  dbMessage: GlobalAssistantMessage, 
  structuredData: { textParts: string[]; partsOrder: Array<{ index: number; type: string; toolCallId?: string }>; originalContent?: string }
): UIMessage {
  const parts: Array<TextPart | ToolPart> = [];
  let textPartIndex = 0;
  
  // Parse tool calls and results for lookup
  const toolCallsMap = new Map<string, ToolCall>();
  const toolResultsMap = new Map<string, ToolResult>();
  
  if (dbMessage.toolCalls) {
    try {
      const toolCalls = typeof dbMessage.toolCalls === 'string' 
        ? JSON.parse(dbMessage.toolCalls) as ToolCall[]
        : Array.isArray(dbMessage.toolCalls) ? dbMessage.toolCalls as ToolCall[] : [];
      toolCalls.forEach(tc => toolCallsMap.set(tc.toolCallId, tc));
    } catch (error) {
      console.error('Error parsing global assistant tool calls:', error);
    }
  }
  
  if (dbMessage.toolResults) {
    try {
      const toolResults = typeof dbMessage.toolResults === 'string'
        ? JSON.parse(dbMessage.toolResults) as ToolResult[]
        : Array.isArray(dbMessage.toolResults) ? dbMessage.toolResults as ToolResult[] : [];
      toolResults.forEach(tr => toolResultsMap.set(tr.toolCallId, tr));
    } catch (error) {
      console.error('Error parsing global assistant tool results:', error);
    }
  }
  
  // Reconstruct parts in original order
  structuredData.partsOrder.forEach(partOrder => {
    if (partOrder.type === 'text') {
      if (textPartIndex < structuredData.textParts.length) {
        const textContent = structuredData.textParts[textPartIndex];
        if (textContent && textContent.trim()) {
          parts.push({
            type: 'text',
            text: textContent,
          });
        }
        textPartIndex++;
      }
    } else if (partOrder.type.startsWith('tool-') && partOrder.toolCallId) {
      const toolCall = toolCallsMap.get(partOrder.toolCallId);
      const toolResult = toolResultsMap.get(partOrder.toolCallId);
      
      if (toolCall) {
        parts.push({
          type: partOrder.type,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
          output: toolResult?.output,
          state: toolResult ? 'output-available' : 'input-available',
        });
      }
    } else if (partOrder.type === 'step-start') {
      // Skip step-start parts for now - they're AI SDK internal
    }
  });
  
  return {
    id: dbMessage.id,
    role: dbMessage.role as 'user' | 'assistant' | 'system',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parts: parts.length > 0 ? (parts as any) : [{ type: 'text', text: structuredData.originalContent || '' }],
    createdAt: dbMessage.createdAt,
    editedAt: dbMessage.editedAt,
    messageType: dbMessage.messageType || 'standard',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}


/**
 * Save a Global Assistant message with tool calls and results to the database
 * Supports both legacy format and new structured format with chronological ordering
 */
export async function saveGlobalAssistantMessageToDatabase({
  messageId,
  conversationId,
  userId,
  role,
  content,
  toolCalls,
  toolResults,
  uiMessage,
}: {
  messageId: string;
  conversationId: string;
  userId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  uiMessage?: UIMessage; // Pass the complete UIMessage to preserve part ordering
}) {
  try {
    let structuredContent = content;
    
    // If we have the complete UIMessage, store structured content to preserve chronological order
    if (uiMessage?.parts && uiMessage.parts.length > 0) {
      const textParts = uiMessage.parts
        .filter(p => p.type === 'text')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map(p => (p as any).text || '');
      
      const partsOrder = uiMessage.parts.map((p, i) => ({
        index: i,
        type: p.type,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolCallId: p.type.startsWith('tool-') ? (p as any).toolCallId : undefined
      }));
      
      structuredContent = JSON.stringify({
        textParts,
        partsOrder,
        originalContent: content, // Keep original for backward compatibility
      });
      
      debugLogAI('Global Assistant: Saving structured content', {
        textPartsCount: textParts.length,
        totalPartsCount: partsOrder.length
      });
    }

    await db.insert(messages)
      .values({
        id: messageId,
        conversationId,
        userId,
        role,
        content: structuredContent,
        toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
        toolResults: toolResults ? JSON.stringify(toolResults) : null,
        createdAt: new Date(),
        isActive: true,
      })
      .onConflictDoUpdate({
        target: messages.id,
        set: {
          content: structuredContent,
          toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
          toolResults: toolResults ? JSON.stringify(toolResults) : null,
        }
      });

    debugLogAI('Global Assistant: Message saved to database with tools');
  } catch (error) {
    console.error('Error saving global assistant message to database:', error);
    throw error;
  }
}

/**
 * Sanitize messages before passing to convertToModelMessages
 * Filters out tool parts without results to prevent "input-available" state errors
 */
export function sanitizeMessagesForModel(messages: UIMessage[]): UIMessage[] {
  return messages.map(message => ({
    ...message,
    parts: message.parts?.filter(part => {
      // Keep text parts
      if (part.type === 'text') return true;
      
      // For tool parts, only keep those with results
      if (part.type.startsWith('tool-')) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolPart = part as any;
        // Only include tool parts that have output (completed executions)
        return toolPart.state === 'output-available' && toolPart.output !== undefined;
      }
      
      // Keep other part types (step-start, etc.)
      return true;
    }) || []
  }));
}