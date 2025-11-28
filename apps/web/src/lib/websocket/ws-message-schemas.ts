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

/**
 * Server -> Client: Challenge message for post-connection verification
 */
export const ChallengeMessageSchema = BaseMessageSchema.extend({
  type: z.literal('challenge'),
  challenge: z.string().length(64), // SHA256 hex string
  expiresIn: z.number().positive(),
});

/**
 * Client -> Server: Challenge response
 */
export const ChallengeResponseMessageSchema = BaseMessageSchema.extend({
  type: z.literal('challenge_response'),
  response: z.string().length(64), // SHA256 hex string
});

/**
 * Server -> Client: Challenge verification result
 */
export const ChallengeVerifiedMessageSchema = BaseMessageSchema.extend({
  type: z.literal('challenge_verified'),
  timestamp: z.number(),
});

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
  ChallengeResponseMessageSchema,
  ToolExecuteMessageSchema,
  ToolResultMessageSchema,
]);

/**
 * Union of all outgoing message types (Server -> Client)
 */
export const OutgoingMessageSchema = z.discriminatedUnion('type', [
  PongMessageSchema,
  ChallengeMessageSchema,
  ChallengeVerifiedMessageSchema,
  ErrorMessageSchema,
]);

/**
 * Type exports for TypeScript type inference
 */
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;
export type ChallengeMessage = z.infer<typeof ChallengeMessageSchema>;
export type ChallengeResponseMessage = z.infer<typeof ChallengeResponseMessageSchema>;
export type ChallengeVerifiedMessage = z.infer<typeof ChallengeVerifiedMessageSchema>;
export type ToolExecuteMessage = z.infer<typeof ToolExecuteMessageSchema>;
export type ToolResultMessage = z.infer<typeof ToolResultMessageSchema>;
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

export function isChallengeResponseMessage(msg: IncomingMessage): msg is ChallengeResponseMessage {
  return msg.type === 'challenge_response';
}

export function isToolExecuteMessage(msg: IncomingMessage): msg is ToolExecuteMessage {
  return msg.type === 'tool_execute';
}

export function isToolResultMessage(msg: IncomingMessage): msg is ToolResultMessage {
  return msg.type === 'tool_result';
}
