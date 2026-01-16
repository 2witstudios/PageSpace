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

/**
 * UI Message part types from AI SDK v5
 * Using discriminated union for type-safe access
 */
type UIMessagePart =
  | { type: 'text'; text: string }
  | { type: 'step-start' }
  | { type: string; toolCallId: string; toolName: string; input?: Record<string, unknown>; output?: unknown; state: string };

/**
 * Type guard for text parts in UIMessage
 */
function isTextPart(part: UIMessagePart): part is { type: 'text'; text: string } {
  return part.type === 'text' && 'text' in part;
}

/**
 * Type guard for tool parts in UIMessage (type starts with 'tool-')
 */
function isToolPart(part: UIMessagePart): part is { type: string; toolCallId: string; toolName: string; input?: Record<string, unknown>; output?: unknown; state: string } {
  return part.type.startsWith('tool-') && 'toolCallId' in part;
}

/**
 * Type guard for tool parts with output available
 */
function hasToolOutput(part: UIMessagePart): part is { type: string; toolCallId: string; toolName: string; output: unknown; state: 'output-available' | 'output-error' } {
  return isToolPart(part) && 'output' in part && part.output !== undefined;
}

/**
 * Safely cast UIMessage.parts to typed array
 */
function getTypedParts(message: UIMessage): UIMessagePart[] {
  return (message.parts ?? []) as UIMessagePart[];
}

/**
 * Extended UIMessage type for PageSpace with additional fields
 * This extends the base AI SDK UIMessage with our custom properties
 */
export interface PageSpaceUIMessage extends Omit<UIMessage, 'parts'> {
  parts: UIMessagePart[];
  editedAt?: Date | null;
  messageType?: 'standard' | 'todo_list';
}

/**
 * Create a PageSpaceUIMessage from components
 * This ensures type safety when constructing messages
 */
function createPageSpaceMessage(params: {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: UIMessagePart[];
  createdAt: Date;
  editedAt?: Date | null;
  messageType?: 'standard' | 'todo_list';
}): UIMessage {
  // Cast to UIMessage for compatibility with AI SDK
  // The extended fields are preserved at runtime
  return params as unknown as UIMessage;
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
  const parts = getTypedParts(message);

  if (parts.length === 0) {
    debugLogAI('extractMessageContent: No parts in message');
    return '';
  }

  debugLogAI('extractMessageContent: Message analysis', {
    partsCount: parts.length,
    partTypes: parts.map(p => p.type)
  });

  const textParts = parts.filter(isTextPart);
  debugLogAI('extractMessageContent: Text parts analysis', {
    textPartsFound: textParts.length
  });

  // Create safe metadata for each text part
  const textPartsMetadata = textParts.map((part, index) => ({
    partIndex: index + 1,
    ...createContentMetadata(part.text)
  }));

  debugLogAI('extractMessageContent: Text parts metadata', {
    parts: textPartsMetadata
  });

  const textContent = textParts
    .map(part => part.text)
    .filter(text => text.trim() !== '')
    .join('');

  debugLogAI('extractMessageContent: Final result', createContentMetadata(textContent));

  return textContent;
}

/**
 * Extract tool calls from UIMessage parts
 */
export function extractToolCalls(message: UIMessage): ToolCall[] {
  const parts = getTypedParts(message);

  return parts
    .filter(isToolPart)
    .map(toolPart => ({
      toolCallId: toolPart.toolCallId,
      toolName: toolPart.toolName || toolPart.type.replace('tool-', ''),
      input: toolPart.input || {},
      state: toolPart.state as ToolCall['state'],
    }));
}

/**
 * Extract tool results from UIMessage parts
 */
export function extractToolResults(message: UIMessage): ToolResult[] {
  const parts = getTypedParts(message);

  return parts
    .filter(hasToolOutput)
    .map(toolPart => ({
      toolCallId: toolPart.toolCallId,
      toolName: toolPart.toolName || toolPart.type.replace('tool-', ''),
      output: toolPart.output,
      state: toolPart.state as ToolResult['state'],
    }));
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
  return createPageSpaceMessage({
    id: dbMessage.id,
    role: dbMessage.role as 'user' | 'assistant' | 'system',
    parts: [{ type: 'text', text: dbMessage.content || '' }],
    createdAt: dbMessage.createdAt,
    editedAt: dbMessage.editedAt,
    messageType: dbMessage.messageType || 'standard',
  });
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

  const finalParts: UIMessagePart[] = parts.length > 0
    ? parts
    : [{ type: 'text', text: structuredData.originalContent || '' }];

  return createPageSpaceMessage({
    id: dbMessage.id,
    role: dbMessage.role as 'user' | 'assistant' | 'system',
    parts: finalParts,
    createdAt: dbMessage.createdAt,
    editedAt: dbMessage.editedAt,
    messageType: dbMessage.messageType || 'standard',
  });
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
}) {
  try {
    let structuredContent = content;

    // If we have the complete UIMessage, store structured content to preserve chronological order
    if (uiMessage?.parts && uiMessage.parts.length > 0) {
      const typedParts = getTypedParts(uiMessage);
      const textParts = typedParts
        .filter(isTextPart)
        .map(p => p.text);

      const partsOrder = typedParts.map((p, i) => ({
        index: i,
        type: p.type,
        toolCallId: isToolPart(p) ? p.toolCallId : undefined
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
      })
      .onConflictDoUpdate({
        target: chatMessages.id,
        set: {
          content: structuredContent,
          toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
          toolResults: toolResults ? JSON.stringify(toolResults) : null,
          conversationId, // Update conversationId if message is reprocessed
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
  return createPageSpaceMessage({
    id: dbMessage.id,
    role: dbMessage.role as 'user' | 'assistant' | 'system',
    parts: [{ type: 'text', text: dbMessage.content || '' }],
    createdAt: dbMessage.createdAt,
    editedAt: dbMessage.editedAt,
    messageType: dbMessage.messageType || 'standard',
  });
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

  const finalParts: UIMessagePart[] = parts.length > 0
    ? parts
    : [{ type: 'text', text: structuredData.originalContent || '' }];

  return createPageSpaceMessage({
    id: dbMessage.id,
    role: dbMessage.role as 'user' | 'assistant' | 'system',
    parts: finalParts,
    createdAt: dbMessage.createdAt,
    editedAt: dbMessage.editedAt,
    messageType: dbMessage.messageType || 'standard',
  });
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
      const typedParts = getTypedParts(uiMessage);
      const textParts = typedParts
        .filter(isTextPart)
        .map(p => p.text);

      const partsOrder = typedParts.map((p, i) => ({
        index: i,
        type: p.type,
        toolCallId: isToolPart(p) ? p.toolCallId : undefined
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
 * Path utilities for converting between PageSpace paths and page IDs
 */
export class PathUtils {
  /**
   * Extract page ID from a PageSpace path like "/drive/folder/page"
   */
  static extractPageIdFromPath(path: string): string {
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1];
  }
  
  /**
   * Extract drive ID from a PageSpace path
   */
  static extractDriveIdFromPath(path: string): string {
    const parts = path.split('/').filter(Boolean);
    return parts[0];
  }
  
  /**
   * Extract parent ID from a PageSpace path (null if root level)
   */
  static extractParentIdFromPath(path: string): string | null {
    const parts = path.split('/').filter(Boolean);
    return parts.length > 2 ? parts[parts.length - 2] : null;
  }
  
  /**
   * Validate path format
   */
  static isValidPath(path: string): boolean {
    if (!path.startsWith('/')) return false;
    const parts = path.split('/').filter(Boolean);
    return parts.length >= 1; // At minimum, must have drive
  }
}

/**
 * Error handling utilities for tools
 */
export class ToolError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * Permission validation helper
 */
export function validateToolPermissions(accessLevel: string | null, requiredLevel: 'VIEW' | 'EDIT' | 'ADMIN'): void {
  if (!accessLevel || accessLevel === 'NONE') {
    throw new ToolError('Access denied', 'permission_check');
  }
  
  const levels = ['VIEW', 'EDIT', 'ADMIN'];
  const userLevelIndex = levels.indexOf(accessLevel);
  const requiredLevelIndex = levels.indexOf(requiredLevel);
  
  if (userLevelIndex < requiredLevelIndex) {
    throw new ToolError(`Insufficient permissions. Required: ${requiredLevel}, Got: ${accessLevel}`, 'permission_check');
  }
}

/**
 * Line number validation for document editing tools
 */
export function validateLineNumbers(
  startLine: number,
  endLine: number,
  totalLines: number,
  operation: 'replace' | 'insert' | 'delete'
): void {
  // For insert operations, allow inserting at the end (totalLines + 1)
  const maxLine = operation === 'insert' ? totalLines + 1 : totalLines;
  
  if (startLine < 1) {
    throw new ToolError('Line numbers must start from 1', 'line_validation');
  }
  
  if (startLine > maxLine) {
    throw new ToolError(
      `Start line ${startLine} exceeds document length (${totalLines} lines)`,
      'line_validation'
    );
  }
  
  if (endLine < startLine) {
    throw new ToolError(
      `End line ${endLine} cannot be before start line ${startLine}`,
      'line_validation'
    );
  }
  
  if (endLine > totalLines && operation !== 'insert') {
    throw new ToolError(
      `End line ${endLine} exceeds document length (${totalLines} lines)`,
      'line_validation'
    );
  }
}

/**
 * Content sanitization for tool inputs
 */
export function sanitizeContent(content: string): string {
  // Basic sanitization - remove null bytes and normalize line endings
  return content
    .replace(/\0/g, '') // Remove null bytes
    .replace(/\r\n/g, '\n') // Normalize Windows line endings
    .replace(/\r/g, '\n'); // Normalize Mac line endings
}

/**
 * Sanitize messages before passing to convertToModelMessages
 * Filters out tool parts without results to prevent "input-available" state errors
 */
export function sanitizeMessagesForModel(inputMessages: UIMessage[]): UIMessage[] {
  return inputMessages.map(message => {
    const typedParts = getTypedParts(message);
    const filteredParts = typedParts.filter(part => {
      // Keep text parts
      if (isTextPart(part)) return true;

      // For tool parts, only keep those with completed output
      if (isToolPart(part)) {
        return hasToolOutput(part);
      }

      // Keep other part types (step-start, etc.)
      return true;
    });

    return {
      ...message,
      parts: filteredParts
    } as UIMessage;
  });
}