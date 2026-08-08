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
  userName?: string | null;
  /**
   * Lifecycle state of an assistant row (see chat_messages.status / messages.status).
   * `'interrupted'` means the generation died mid-flight and this is a real, partial
   * reply, terminal and never resumed on its own — MessageRenderer badges it and
   * surfaces a retry hint. Absent on rows saved before this column existed, which
   * read as `'complete'` server-side by default.
   */
  status?: 'streaming' | 'complete' | 'interrupted';
}

/**
 * A text part within a message
 */
export interface TextPart {
  type: 'text';
  text: string;
}

/**
 * A file/image part within a message (from AI SDK FileUIPart)
 */
export interface FilePart {
  type: 'file';
  url: string;
  mediaType?: string;
  filename?: string;
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
 * A group of consecutive file/image parts
 */
export interface FileGroupPart {
  type: 'file-group';
  parts: FilePart[];
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
 * Universal Commands execution feedback part (UX spec §7): streamed at
 * response start and persisted with the message. `data` is validated by
 * the indicator's view-model, not trusted here.
 */
export interface CommandExecutionPart {
  type: 'data-command-execution';
  id?: string;
  data: unknown;
}

/**
 * A run of 1+ consecutive non-diff tool calls, rendered through one
 * persistent component (ToolRunGroup/CompactToolRunGroup) regardless of
 * length. Diff-producing tool calls (see tool-calls/tool-significance.ts)
 * always break a run and render standalone instead.
 */
export interface ToolRunGroupPart {
  type: 'tool-run-group';
  /**
   * Derived from the first call's toolCallId inside useGroupedParts. Stays
   * identical for as long as this is "the same run" (parts.length may grow
   * from 1 to N across re-renders as more calls stream in) and changes only
   * when a new run starts (e.g. a standalone/diff tool split it). Consumers
   * must use this — not array index — as the React key AND as the
   * useToolCallOpenState lookup key for the run's own header open state.
   */
  runKey: string;
  parts: ProcessedToolPart[];
}

/**
 * Union type for processed message parts
 */
export type GroupedPart = TextGroupPart | FileGroupPart | ProcessedToolPart | CommandExecutionPart | ToolRunGroupPart;

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
 * Type guard for FileGroupPart
 */
export function isFileGroupPart(part: GroupedPart): part is FileGroupPart {
  return part.type === 'file-group';
}

/**
 * Type guard for ProcessedToolPart
 */
export function isProcessedToolPart(part: GroupedPart): part is ProcessedToolPart {
  return part.type !== 'tool-run-group' && part.type.startsWith('tool-');
}

/**
 * Type guard for CommandExecutionPart
 */
export function isCommandExecutionPart(part: GroupedPart): part is CommandExecutionPart {
  return part.type === 'data-command-execution';
}

/**
 * Type guard for ToolRunGroupPart
 */
export function isToolRunGroupPart(part: GroupedPart): part is ToolRunGroupPart {
  return part.type === 'tool-run-group';
}
