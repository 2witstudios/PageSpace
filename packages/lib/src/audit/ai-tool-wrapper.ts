/**
 * AI Tool Audit Wrapper
 *
 * Provides automatic audit trail tracking for AI tool execution.
 * Wraps AI tools to track which tools were called, with what parameters,
 * and links them to the AI operations that invoked them.
 *
 * @module ai-tool-wrapper
 */

import { trackAiOperation, type TrackAiOperationParams, type AiOperationController } from './track-ai-operation';
import type { CoreTool } from 'ai';

/**
 * Context passed to AI tools
 */
export interface AiToolContext {
  userId: string;
  locationContext?: {
    currentPage?: {
      id: string;
      title: string;
      type: string;
      path: string;
    };
    currentDrive?: {
      id: string;
      name: string;
      slug: string;
    };
    breadcrumbs?: string[];
  };
  modelCapabilities?: {
    hasTools: boolean;
    hasVision: boolean;
  };
}

/**
 * Tool execution result that includes audit information
 */
export interface AuditedToolResult {
  result: any;
  toolName: string;
  pageIds?: string[]; // Pages that were modified
  driveIds?: string[]; // Drives that were affected
  actionType?: string; // Type of action performed (create, update, delete, move)
}

/**
 * Options for AI operation tracking
 */
export interface AiOperationTrackingOptions {
  agentType: 'ASSISTANT' | 'EDITOR' | 'PLANNER' | 'PARTNER' | 'WRITER' | 'CUSTOM';
  provider: string;
  model: string;
  conversationId?: string;
  messageId?: string;
  userPrompt?: string;
  systemPrompt?: string;
}

/**
 * Wraps a tool execution with audit tracking
 *
 * This function is designed to be used internally by the AI chat system
 * to automatically track tool calls without modifying the tool definitions.
 *
 * @param toolName - Name of the tool being executed
 * @param toolExecute - The tool's execute function
 * @param args - Arguments passed to the tool
 * @param context - Execution context with user info
 * @param aiOperationId - Optional AI operation ID to link this tool call to
 * @returns The tool result with audit metadata
 *
 * @example
 * ```typescript
 * const result = await executeToolWithAudit(
 *   'create_page',
 *   createPageTool.execute,
 *   { title: 'New Page', type: 'DOCUMENT', driveId: 'drive-123' },
 *   { userId: 'user-123', locationContext: {...} },
 *   'ai-op-456'
 * );
 * ```
 */
export async function executeToolWithAudit<TArgs extends Record<string, any>, TResult>(
  toolName: string,
  toolExecute: (args: TArgs, options: { experimental_context: AiToolContext }) => Promise<TResult>,
  args: TArgs,
  context: AiToolContext,
  aiOperationId?: string
): Promise<AuditedToolResult> {
  const startTime = Date.now();

  try {
    // Execute the tool with the provided context
    const result = await toolExecute(args, { experimental_context: context });

    // Extract page IDs and drive IDs from the result
    const pageIds = extractPageIds(result);
    const driveIds = extractDriveIds(result);
    const actionType = extractActionType(toolName, result);

    // Return the result with audit metadata
    return {
      result,
      toolName,
      pageIds,
      driveIds,
      actionType,
    };
  } catch (error) {
    // Re-throw the error but log the failure
    console.error(`[AI Tool Audit] Tool execution failed: ${toolName}`, {
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: Date.now() - startTime,
      aiOperationId,
    });
    throw error;
  }
}

/**
 * Creates an AI operation tracker for a conversation turn
 *
 * This should be called at the start of an AI chat response to track
 * the overall operation, then individual tool calls are linked to it.
 *
 * @param options - AI operation tracking options
 * @param context - Tool execution context
 * @returns Operation controller for completing/failing the operation
 *
 * @example
 * ```typescript
 * const operation = await createAiOperationTracker({
 *   agentType: 'PARTNER',
 *   provider: 'openai',
 *   model: 'gpt-4',
 *   conversationId: 'conv-123',
 *   userPrompt: 'Create 3 project documents'
 * }, { userId: 'user-123', locationContext: {...} });
 *
 * try {
 *   // Execute AI tools...
 *   await operation.complete({
 *     completion: 'Created 3 documents successfully',
 *     actionsPerformed: { created: 3 },
 *     tokens: { input: 100, output: 200, cost: 50 }
 *   });
 * } catch (error) {
 *   await operation.fail(error.message);
 * }
 * ```
 */
export async function createAiOperationTracker(
  options: AiOperationTrackingOptions,
  context: AiToolContext
): Promise<AiOperationController> {
  const {
    agentType,
    provider,
    model,
    conversationId,
    messageId,
    userPrompt,
    systemPrompt,
  } = options;

  const params: TrackAiOperationParams = {
    userId: context.userId,
    agentType,
    provider,
    model,
    operationType: 'chat', // Could be 'chat', 'edit', 'generation', etc.
    prompt: userPrompt,
    systemPrompt,
    conversationId,
    messageId,
    driveId: context.locationContext?.currentDrive?.id,
    pageId: context.locationContext?.currentPage?.id,
  };

  return trackAiOperation(params);
}

/**
 * Extracts page IDs from a tool execution result
 *
 * Looks for common patterns in tool results to identify affected pages.
 */
function extractPageIds(result: any): string[] {
  if (!result) return [];

  const pageIds = new Set<string>();

  // Direct pageId field
  if (result.id && typeof result.id === 'string') {
    pageIds.add(result.id);
  }

  if (result.pageId && typeof result.pageId === 'string') {
    pageIds.add(result.pageId);
  }

  // Array of pages
  if (Array.isArray(result.pages)) {
    result.pages.forEach((page: any) => {
      if (page.id) pageIds.add(page.id);
    });
  }

  // Batch operation results
  if (result.successful && Array.isArray(result.successful)) {
    result.successful.forEach((item: any) => {
      if (item.pageId) pageIds.add(item.pageId);
      if (item.id) pageIds.add(item.id);
    });
  }

  // Multiple page IDs in result
  if (result.pageIds && Array.isArray(result.pageIds)) {
    result.pageIds.forEach((id: string) => pageIds.add(id));
  }

  return Array.from(pageIds);
}

/**
 * Extracts drive IDs from a tool execution result
 */
function extractDriveIds(result: any): string[] {
  if (!result) return [];

  const driveIds = new Set<string>();

  if (result.driveId && typeof result.driveId === 'string') {
    driveIds.add(result.driveId);
  }

  if (result.driveIds && Array.isArray(result.driveIds)) {
    result.driveIds.forEach((id: string) => driveIds.add(id));
  }

  return Array.from(driveIds);
}

/**
 * Extracts action type from tool name and result
 */
function extractActionType(toolName: string, result: any): string {
  // Map tool names to action types
  const actionTypeMap: Record<string, string> = {
    'create_page': 'PAGE_CREATE',
    'update_page_content': 'PAGE_UPDATE',
    'rename_page': 'PAGE_RENAME',
    'move_page': 'PAGE_MOVE',
    'trash_page': 'PAGE_DELETE',
    'trash_page_with_children': 'PAGE_DELETE',
    'restore_page': 'PAGE_RESTORE',
    'delete_lines': 'PAGE_UPDATE',
    'insert_lines': 'PAGE_UPDATE',
    'replace_lines': 'PAGE_UPDATE',
    'append_to_page': 'PAGE_UPDATE',
    'prepend_to_page': 'PAGE_UPDATE',
    'bulk_update_content': 'BULK_UPDATE',
    'bulk_move_pages': 'BULK_MOVE',
    'organize_pages_by_tags': 'BULK_ORGANIZE',
  };

  return actionTypeMap[toolName] || 'UNKNOWN';
}

/**
 * Enhanced tool wrapper that automatically tracks AI operations
 *
 * This is a decorator pattern that wraps an entire tool definition
 * to add audit tracking capabilities without modifying the tool itself.
 *
 * @param tool - The AI SDK tool to wrap
 * @param options - Configuration options for audit tracking
 * @returns Wrapped tool with audit tracking
 *
 * @example
 * ```typescript
 * const auditedCreatePage = withAuditTracking(createPageTool, {
 *   trackPageModifications: true,
 *   captureParameters: true
 * });
 * ```
 */
export function withAuditTracking<T extends CoreTool>(
  tool: T,
  options: {
    trackPageModifications?: boolean;
    captureparameters?: boolean;
    aiOperationIdProvider?: () => string | undefined;
  } = {}
): T {
  const originalExecute = tool.execute;

  // Wrap the execute function
  const wrappedExecute = async (args: any, context: any) => {
    const aiOperationId = options.aiOperationIdProvider?.();

    // Store tool call metadata in context if AI operation ID is available
    if (aiOperationId && options.trackPageModifications) {
      console.debug(`[AI Tool Audit] Executing tool with tracking`, {
        toolName: tool.description?.split('.')[0] || 'unknown',
        aiOperationId,
        hasContext: !!context,
      });
    }

    // Execute the original tool
    const result = await originalExecute(args, context);

    // If tracking is enabled and we have an operation ID, record the tool usage
    if (aiOperationId && options.trackPageModifications) {
      const pageIds = extractPageIds(result);
      const driveIds = extractDriveIds(result);

      if (pageIds.length > 0 || driveIds.length > 0) {
        console.debug(`[AI Tool Audit] Tool modified pages/drives`, {
          pageIds,
          driveIds,
          aiOperationId,
        });
      }
    }

    return result;
  };

  // Return a new tool with the wrapped execute function
  return {
    ...tool,
    execute: wrappedExecute,
  } as T;
}
