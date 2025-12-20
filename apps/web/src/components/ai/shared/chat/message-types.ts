/**
 * Shared types for message rendering components.
 * Used by both MessageRenderer and CompactMessageRenderer.
 */

import { UIMessage } from 'ai';

/**
 * Extended message interface that includes database fields
 */
export interface ConversationMessage extends UIMessage {
  messageType?: 'standard' | 'todo_list';
  conversationId?: string;
  isActive?: boolean;
  editedAt?: Date;
  createdAt?: Date;
}

/**
 * A text part within a message
 */
export interface TextPart {
  type: 'text';
  text: string;
}

/**
 * A tool call part within a message (raw from AI SDK)
 */
export interface ToolPart {
  type: string; // "tool-{toolName}"
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
}

/**
 * A group of consecutive text parts
 */
export interface TextGroupPart {
  type: 'text-group';
  parts: TextPart[];
}

/**
 * A processed tool part for rendering (normalized from raw ToolPart)
 */
export interface ProcessedToolPart {
  type: string; // "tool-{toolName}"
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error' | 'done' | 'streaming';
}

/**
 * Union type for processed message parts
 */
export type GroupedPart = TextGroupPart | ProcessedToolPart;

/**
 * Valid tool states for type checking
 */
export const VALID_TOOL_STATES = ['input-streaming', 'input-available', 'output-available', 'output-error', 'done', 'streaming'] as const;
export type ValidToolState = typeof VALID_TOOL_STATES[number];

/**
 * Type guard for valid tool states
 */
export function isValidToolState(value: unknown): value is ValidToolState {
  return typeof value === 'string' && (VALID_TOOL_STATES as readonly string[]).includes(value);
}

/**
 * Type guard for TextGroupPart
 */
export function isTextGroupPart(part: GroupedPart): part is TextGroupPart {
  return part.type === 'text-group';
}

/**
 * Type guard for ProcessedToolPart
 */
export function isProcessedToolPart(part: GroupedPart): part is ProcessedToolPart {
  return part.type.startsWith('tool-');
}
