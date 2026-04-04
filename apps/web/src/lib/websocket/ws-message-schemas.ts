/**
 * WebSocket Message Validation Schemas
 * Zod schemas for all WebSocket message types in the MCP bridge
 * Provides runtime validation and type safety
 */

import { z } from 'zod';

/**
 * Base message schema with common fields
 */
const BaseMessageSchema = z.object({
  type: z.string(),
  timestamp: z.number().optional(),
});

/**
 * Client -> Server: Ping message for health checks
 */
export const PingMessageSchema = BaseMessageSchema.extend({
  type: z.literal('ping'),
});

/**
 * Server -> Client: Pong response
 */
export const PongMessageSchema = BaseMessageSchema.extend({
  type: z.literal('pong'),
  timestamp: z.number(),
});

// Note: Challenge schemas removed - auth migrated to opaque session tokens
// See: fix/desktop-ws-opaque-token-auth

/**
 * Client -> Server: Tool execution request
 */
export const ToolExecuteMessageSchema = BaseMessageSchema.extend({
  type: z.literal('tool_execute'),
  id: z.string(),
  serverName: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(64),
  toolName: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(64),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Client -> Server: Tool execution result
 */
export const ToolResultMessageSchema = BaseMessageSchema.extend({
  type: z.literal('tool_result'),
  id: z.string(),
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

/**
 * Client -> Server: Fetch response start (desktop bridge sends HTTP response metadata)
 */
export const FetchResponseStartMessageSchema = BaseMessageSchema.extend({
  type: z.literal('fetch_response_start'),
  id: z.string(),
  status: z.number(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
});

/**
 * Client -> Server: Fetch response chunk (desktop bridge streams response body)
 */
export const FetchResponseChunkMessageSchema = BaseMessageSchema.extend({
  type: z.literal('fetch_response_chunk'),
  id: z.string(),
  chunk: z.string(),
});

/**
 * Client -> Server: Fetch response end (desktop bridge signals response complete)
 */
export const FetchResponseEndMessageSchema = BaseMessageSchema.extend({
  type: z.literal('fetch_response_end'),
  id: z.string(),
});

/**
 * Client -> Server: Fetch response error (desktop bridge signals fetch failure)
 */
export const FetchResponseErrorMessageSchema = BaseMessageSchema.extend({
  type: z.literal('fetch_response_error'),
  id: z.string(),
  error: z.string(),
});

/**
 * Server -> Client: Error message
 */
export const ErrorMessageSchema = BaseMessageSchema.extend({
  type: z.literal('error'),
  error: z.string(),
  reason: z.string().optional(),
  retryAfter: z.number().optional(),
});

/**
 * Union of all incoming message types (Client -> Server)
 */
export const IncomingMessageSchema = z.discriminatedUnion('type', [
  PingMessageSchema,
  ToolExecuteMessageSchema,
  ToolResultMessageSchema,
  FetchResponseStartMessageSchema,
  FetchResponseChunkMessageSchema,
  FetchResponseEndMessageSchema,
  FetchResponseErrorMessageSchema,
]);

/**
 * Union of all outgoing message types (Server -> Client)
 */
export const OutgoingMessageSchema = z.discriminatedUnion('type', [
  PongMessageSchema,
  ErrorMessageSchema,
]);

/**
 * Type exports for TypeScript type inference
 */
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;
export type ToolExecuteMessage = z.infer<typeof ToolExecuteMessageSchema>;
export type ToolResultMessage = z.infer<typeof ToolResultMessageSchema>;
export type FetchResponseStartMessage = z.infer<typeof FetchResponseStartMessageSchema>;
export type FetchResponseChunkMessage = z.infer<typeof FetchResponseChunkMessageSchema>;
export type FetchResponseEndMessage = z.infer<typeof FetchResponseEndMessageSchema>;
export type FetchResponseErrorMessage = z.infer<typeof FetchResponseErrorMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

export type IncomingMessage = z.infer<typeof IncomingMessageSchema>;
export type OutgoingMessage = z.infer<typeof OutgoingMessageSchema>;

/**
 * Message validation helper functions
 */

/**
 * Validates an incoming WebSocket message
 * @param data - Raw message data
 * @returns Validated message or null if invalid
 */
export function validateIncomingMessage(data: unknown): IncomingMessage | null {
  try {
    return IncomingMessageSchema.parse(data);
  } catch {
    return null;
  }
}

/**
 * Validates an incoming message and returns detailed error
 * @param data - Raw message data
 * @returns Success result or detailed error
 */
export function validateIncomingMessageWithError(data: unknown): {
  success: true;
  data: IncomingMessage;
} | {
  success: false;
  error: string;
  issues: Array<{ path: string; message: string }>;
} {
  const result = IncomingMessageSchema.safeParse(data);

  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }

  return {
    success: false,
    error: 'Message validation failed',
    issues: result.error.issues.map(issue => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/**
 * Type guard for specific message types
 */
export function isPingMessage(msg: IncomingMessage): msg is PingMessage {
  return msg.type === 'ping';
}

export function isToolExecuteMessage(msg: IncomingMessage): msg is ToolExecuteMessage {
  return msg.type === 'tool_execute';
}

export function isToolResultMessage(msg: IncomingMessage): msg is ToolResultMessage {
  return msg.type === 'tool_result';
}

export function isFetchResponseStartMessage(msg: IncomingMessage): msg is FetchResponseStartMessage {
  return msg.type === 'fetch_response_start';
}

export function isFetchResponseChunkMessage(msg: IncomingMessage): msg is FetchResponseChunkMessage {
  return msg.type === 'fetch_response_chunk';
}

export function isFetchResponseEndMessage(msg: IncomingMessage): msg is FetchResponseEndMessage {
  return msg.type === 'fetch_response_end';
}

export function isFetchResponseErrorMessage(msg: IncomingMessage): msg is FetchResponseErrorMessage {
  return msg.type === 'fetch_response_error';
}
