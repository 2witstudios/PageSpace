import {
  type UIMessage,
  type TextUIPart,
  type FileUIPart,
  type DynamicToolUIPart,
} from 'ai';
import { db, chatMessages, messages } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

/** Narrow a UIMessage part to TextUIPart */
function isTextPart(part: { type: string }): part is TextUIPart {
  return part.type === 'text';
}

/** Narrow a UIMessage part to FileUIPart */
function isFilePart(part: { type: string }): part is FileUIPart {
  return part.type === 'file';
}

/**
 * Narrow a UIMessage part to a tool invocation shape.
 * SDK tool parts have type `tool-${name}` and carry toolCallId/toolName/state etc.
 * We use DynamicToolUIPart as the closest match since our tools aren't statically typed.
 */
function isToolInvocationPart(
  part: { type: string }
): part is DynamicToolUIPart & { toolName: string; type: string } {
  return part.type.startsWith('tool-');
}

/**
 * Assistant utilities for AI tool calling and message handling
 * Provides helper functions for tool execution, permission checking, and message conversion
 */

/**
 * Safe debug logging utilities for AI content
 * Prevents sensitive user content from being logged while maintaining operational visibility
 */
const isAIDebugEnabled = process.env.AI_DEBUG_LOGGING === 'true';

function createContentMetadata(content: string): Record<string, unknown> {
  return {
    length: content.length,
    hasContent: content.length > 0,
    isEmpty: content.trim() === '',
    preview: content.length > 0 ? `[CONTENT_REDACTED:${content.length}chars]` : '[EMPTY]'
  };
}

function debugLogAI(message: string, data?: Record<string, unknown>): void {
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

/** Local tool part shape for reconstructing parts from database data */
interface ToolPart {
  type: string; // "tool-{toolName}"
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
}

/** Extended UIMessage with extra fields stored in our database */
type ExtendedUIMessage = UIMessage & { editedAt?: Date | null; messageType: string; createdAt?: Date };

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

interface ReconstructableMessage {
  id: string;
  role: string;
  toolCalls: unknown;
  toolResults: unknown;
  createdAt: Date;
  editedAt?: Date | null;
  messageType?: string;
}

interface StructuredContentData {
  textParts: string[];
  fileParts?: Array<{ url: string; mediaType?: string; filename?: string }>;
  partsOrder: Array<{ index: number; type: string; toolCallId?: string }>;
  originalContent?: string;
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

  const textParts = message.parts.filter(isTextPart);
  debugLogAI('extractMessageContent: Text parts analysis', {
    textPartsFound: textParts.length
  });

  // Create safe metadata for each text part
  const textPartsMetadata = textParts.map((part, index) => ({
    partIndex: index + 1,
    ...createContentMetadata(part.text || '')
  }));

  debugLogAI('extractMessageContent: Text parts metadata', {
    parts: textPartsMetadata
  });

  const textContent = textParts
    .map(part => part.text || '')
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
    .filter(isToolInvocationPart)
    .map(toolPart => ({
      toolCallId: toolPart.toolCallId,
      toolName: toolPart.toolName || toolPart.type.replace('tool-', ''),
      input: (toolPart.input as Record<string, unknown>) || {},
      state: toolPart.state,
    }));
}

/**
 * Extract tool results from UIMessage parts
 */
export function extractToolResults(message: UIMessage): ToolResult[] {
  if (!message.parts) return [];

  return message.parts
    .filter(isToolInvocationPart)
    .filter(toolPart => toolPart.state === 'output-available' || toolPart.state === 'output-error')
    .map(toolPart => ({
      toolCallId: toolPart.toolCallId,
      toolName: toolPart.toolName || toolPart.type.replace('tool-', ''),
      output: 'output' in toolPart ? toolPart.output : undefined,
      state: toolPart.state as 'output-available' | 'output-error',
    }));
}

/**
 * Parse JSON-serialised tool calls from a database column.
 * The column is typed as `string | null` — this helper handles both
 * the expected JSON-string case and legacy array values defensively.
 */
function parseToolCalls(raw: unknown): ToolCall[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as ToolCall[];
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ToolCall[] : [];
  } catch (error) {
    loggers.ai.warn('Failed to parse tool calls from database', { error, rawLength: typeof raw === 'string' ? raw.length : 0 });
    return [];
  }
}

function parseToolResults(raw: unknown): ToolResult[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as ToolResult[];
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as ToolResult[] : [];
  } catch (error) {
    loggers.ai.warn('Failed to parse tool results from database', { error, rawLength: typeof raw === 'string' ? raw.length : 0 });
    return [];
  }
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
    parts: [{ type: 'text' as const, text: dbMessage.content || '' }],
    createdAt: dbMessage.createdAt,
    editedAt: dbMessage.editedAt,
    messageType: dbMessage.messageType || 'standard',
  } as ExtendedUIMessage;
}

/**
 * Shared helper: reconstruct a UIMessage from structured content data and
 * the common fields present on both DatabaseMessage and GlobalAssistantMessage.
 */
function reconstructFromStructuredContent(
  msg: ReconstructableMessage,
  structuredData: StructuredContentData
): UIMessage {
  const parts: Array<TextUIPart | ToolPart | FileUIPart> = [];
  let textPartIndex = 0;
  let filePartIndex = 0;

  // Parse tool calls and results for lookup
  const toolCallsMap = new Map<string, ToolCall>();
  const toolResultsMap = new Map<string, ToolResult>();

  for (const tc of parseToolCalls(msg.toolCalls)) {
    toolCallsMap.set(tc.toolCallId, tc);
  }
  for (const tr of parseToolResults(msg.toolResults)) {
    toolResultsMap.set(tr.toolCallId, tr);
  }

  const fileParts = structuredData.fileParts || [];

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
    } else if (partOrder.type === 'file') {
      if (filePartIndex < fileParts.length) {
        const fp = fileParts[filePartIndex];
        parts.push({
          type: 'file',
          url: fp.url,
          mediaType: fp.mediaType || 'application/octet-stream',
          filename: fp.filename,
        });
        filePartIndex++;
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

  const resolvedParts: UIMessage['parts'] = parts.length > 0
    ? parts as UIMessage['parts']
    : [{ type: 'text' as const, text: structuredData.originalContent || '' }];

  return {
    id: msg.id,
    role: msg.role as 'user' | 'assistant' | 'system',
    parts: resolvedParts,
    createdAt: msg.createdAt,
    editedAt: msg.editedAt,
    messageType: msg.messageType || 'standard',
  } as ExtendedUIMessage;
}

/**
 * Reconstruct message from structured content (new format with chronological ordering)
 */
function reconstructMessageFromStructuredContent(
  dbMessage: DatabaseMessage,
  structuredData: StructuredContentData
): UIMessage {
  return reconstructFromStructuredContent(dbMessage, structuredData);
}

/**
 * Extract structured content data from UIMessage parts for database storage
 */
function extractStructuredContentFromParts(uiParts: UIMessage['parts'], originalContent: string): string {
  const textParts = uiParts
    .filter(isTextPart)
    .map(p => p.text || '');

  const filePartsData = uiParts
    .filter(isFilePart)
    .map(fp => ({
      url: fp.url,
      mediaType: fp.mediaType,
      filename: fp.filename,
    }));

  const partsOrder = uiParts.map((p, i) => ({
    index: i,
    type: p.type,
    toolCallId: isToolInvocationPart(p) ? p.toolCallId : undefined,
  }));

  return JSON.stringify({
    textParts,
    ...(filePartsData.length > 0 ? { fileParts: filePartsData } : {}),
    partsOrder,
    originalContent,
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
      structuredContent = extractStructuredContentFromParts(uiMessage.parts, content);

      debugLogAI('Saving structured content', {
        textPartsCount: uiMessage.parts.filter(isTextPart).length,
        filePartsCount: uiMessage.parts.filter(isFilePart).length,
        totalPartsCount: uiMessage.parts.length
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
    loggers.ai.error('Failed to save message to database', error as Error);
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
    parts: [{ type: 'text' as const, text: dbMessage.content || '' }],
    createdAt: dbMessage.createdAt,
    editedAt: dbMessage.editedAt,
    messageType: dbMessage.messageType || 'standard',
  } as ExtendedUIMessage;
}

/**
 * Reconstruct Global Assistant message from structured content (new format with chronological ordering)
 */
function reconstructGlobalAssistantMessageFromStructuredContent(
  dbMessage: GlobalAssistantMessage,
  structuredData: StructuredContentData
): UIMessage {
  return reconstructFromStructuredContent(dbMessage, structuredData);
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
      structuredContent = extractStructuredContentFromParts(uiMessage.parts, content);

      debugLogAI('Global Assistant: Saving structured content', {
        textPartsCount: uiMessage.parts.filter(isTextPart).length,
        filePartsCount: uiMessage.parts.filter(isFilePart).length,
        totalPartsCount: uiMessage.parts.length
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
    loggers.ai.error('Failed to save global assistant message to database', error as Error);
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
export function sanitizeMessagesForModel(msgs: UIMessage[]): UIMessage[] {
  return msgs.map(message => ({
    ...message,
    parts: message.parts?.filter(part => {
      // Keep text parts
      if (part.type === 'text') return true;

      // Keep file parts (image attachments for vision)
      if (part.type === 'file') return true;

      // For tool parts, only keep those with results
      if (isToolInvocationPart(part)) {
        // Only include tool parts that have output (completed executions)
        return part.state === 'output-available' && 'output' in part && part.output !== undefined;
      }

      // Keep other part types (step-start, etc.)
      return true;
    }) || []
  }));
}
