/**
 * WebSocket Message Schema Validation Tests
 * Tests for Zod schema validation of all message types
 */

import { describe, it, expect } from 'vitest';
import {
  PingMessageSchema,
  PongMessageSchema,
  ChallengeMessageSchema,
  ChallengeResponseMessageSchema,
  ChallengeVerifiedMessageSchema,
  ToolExecuteMessageSchema,
  ToolResultMessageSchema,
  ErrorMessageSchema,
  IncomingMessageSchema,
  OutgoingMessageSchema,
  validateIncomingMessage,
  validateIncomingMessageWithError,
  isPingMessage,
  isChallengeResponseMessage,
  isToolExecuteMessage,
  isToolResultMessage,
} from '../ws-message-schemas';

describe('WebSocket Message Schemas', () => {
  describe('PingMessageSchema', () => {
    it('should validate valid ping message', () => {
      const validMessage = {
        type: 'ping',
      };

      const result = PingMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should validate ping with optional timestamp', () => {
      const validMessage = {
        type: 'ping',
        timestamp: Date.now(),
      };

      const result = PingMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should reject ping with wrong type', () => {
      const invalidMessage = {
        type: 'pong',
      };

      const result = PingMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });

    it('should reject ping with invalid timestamp', () => {
      const invalidMessage = {
        type: 'ping',
        timestamp: 'not-a-number',
      };

      const result = PingMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });
  });

  describe('PongMessageSchema', () => {
    it('should validate valid pong message', () => {
      const validMessage = {
        type: 'pong',
        timestamp: Date.now(),
      };

      const result = PongMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should reject pong without timestamp', () => {
      const invalidMessage = {
        type: 'pong',
      };

      const result = PongMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });
  });

  describe('ChallengeMessageSchema', () => {
    it('should validate valid challenge message', () => {
      const validMessage = {
        type: 'challenge',
        challenge: 'a'.repeat(64), // 64 char hex string
        expiresIn: 30000,
      };

      const result = ChallengeMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should reject challenge with wrong length', () => {
      const invalidMessage = {
        type: 'challenge',
        challenge: 'abc', // Too short
        expiresIn: 30000,
      };

      const result = ChallengeMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });

    it('should reject challenge with negative expiration', () => {
      const invalidMessage = {
        type: 'challenge',
        challenge: 'a'.repeat(64),
        expiresIn: -1000,
      };

      const result = ChallengeMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });

    it('should reject challenge with zero expiration', () => {
      const invalidMessage = {
        type: 'challenge',
        challenge: 'a'.repeat(64),
        expiresIn: 0,
      };

      const result = ChallengeMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });
  });

  describe('ChallengeResponseMessageSchema', () => {
    it('should validate valid challenge response', () => {
      const validMessage = {
        type: 'challenge_response',
        response: 'b'.repeat(64), // 64 char hex string
      };

      const result = ChallengeResponseMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should reject response with wrong length', () => {
      const invalidMessage = {
        type: 'challenge_response',
        response: 'abc',
      };

      const result = ChallengeResponseMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });
  });

  describe('ChallengeVerifiedMessageSchema', () => {
    it('should validate valid challenge verified message', () => {
      const validMessage = {
        type: 'challenge_verified',
        timestamp: Date.now(),
      };

      const result = ChallengeVerifiedMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should reject without timestamp', () => {
      const invalidMessage = {
        type: 'challenge_verified',
      };

      const result = ChallengeVerifiedMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });
  });

  describe('ToolExecuteMessageSchema', () => {
    it('should validate valid tool execute message', () => {
      const validMessage = {
        type: 'tool_execute',
        id: 'request_123',
        serverName: 'my-server',
        toolName: 'read-file',
        arguments: { path: '/test.txt' },
      };

      const result = ToolExecuteMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should validate without arguments', () => {
      const validMessage = {
        type: 'tool_execute',
        id: 'request_123',
        serverName: 'my-server',
        toolName: 'list-files',
      };

      const result = ToolExecuteMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should reject invalid server name characters', () => {
      const invalidMessage = {
        type: 'tool_execute',
        id: 'request_123',
        serverName: 'my@server', // @ not allowed
        toolName: 'read-file',
      };

      const result = ToolExecuteMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });

    it('should reject invalid tool name characters', () => {
      const invalidMessage = {
        type: 'tool_execute',
        id: 'request_123',
        serverName: 'my-server',
        toolName: 'read/file', // / not allowed
      };

      const result = ToolExecuteMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });

    it('should reject server name exceeding max length', () => {
      const invalidMessage = {
        type: 'tool_execute',
        id: 'request_123',
        serverName: 'a'.repeat(65), // Max 64
        toolName: 'read-file',
      };

      const result = ToolExecuteMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });

    it('should reject tool name exceeding max length', () => {
      const invalidMessage = {
        type: 'tool_execute',
        id: 'request_123',
        serverName: 'my-server',
        toolName: 'a'.repeat(65), // Max 64
      };

      const result = ToolExecuteMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });

    it('should accept valid characters in names', () => {
      const validChars = {
        type: 'tool_execute',
        id: 'request_123',
        serverName: 'my-server_123',
        toolName: 'read-file-v2',
      };

      const result = ToolExecuteMessageSchema.safeParse(validChars);
      expect(result.success).toBe(true);
    });
  });

  describe('ToolResultMessageSchema', () => {
    it('should validate successful result', () => {
      const validMessage = {
        type: 'tool_result',
        id: 'request_123',
        success: true,
        result: { content: 'file contents' },
      };

      const result = ToolResultMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should validate error result', () => {
      const validMessage = {
        type: 'tool_result',
        id: 'request_123',
        success: false,
        error: 'File not found',
      };

      const result = ToolResultMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should validate with both result and error', () => {
      const validMessage = {
        type: 'tool_result',
        id: 'request_123',
        success: false,
        result: null,
        error: 'Error message',
      };

      const result = ToolResultMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should reject without required fields', () => {
      const invalidMessage = {
        type: 'tool_result',
        id: 'request_123',
      };

      const result = ToolResultMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });
  });

  describe('ErrorMessageSchema', () => {
    it('should validate error message', () => {
      const validMessage = {
        type: 'error',
        error: 'rate_limit_exceeded',
        retryAfter: 60000,
      };

      const result = ErrorMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should validate minimal error message', () => {
      const validMessage = {
        type: 'error',
        error: 'invalid_message',
      };

      const result = ErrorMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should validate with reason', () => {
      const validMessage = {
        type: 'error',
        error: 'validation_failed',
        reason: 'Missing required field',
      };

      const result = ErrorMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });
  });

  describe('IncomingMessageSchema (Discriminated Union)', () => {
    it('should validate ping message', () => {
      const message = { type: 'ping' };
      const result = IncomingMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should validate challenge_response message', () => {
      const message = {
        type: 'challenge_response',
        response: 'a'.repeat(64),
      };
      const result = IncomingMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should validate tool_execute message', () => {
      const message = {
        type: 'tool_execute',
        id: 'req_123',
        serverName: 'server',
        toolName: 'tool',
      };
      const result = IncomingMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should validate tool_result message', () => {
      const message = {
        type: 'tool_result',
        id: 'req_123',
        success: true,
      };
      const result = IncomingMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should reject unknown message type', () => {
      const message = {
        type: 'unknown_type',
        data: 'test',
      };
      const result = IncomingMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
    });

    it('should reject outgoing message types', () => {
      const message = {
        type: 'pong',
        timestamp: Date.now(),
      };
      const result = IncomingMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
    });
  });

  describe('OutgoingMessageSchema (Discriminated Union)', () => {
    it('should validate pong message', () => {
      const message = { type: 'pong', timestamp: Date.now() };
      const result = OutgoingMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should validate challenge message', () => {
      const message = {
        type: 'challenge',
        challenge: 'a'.repeat(64),
        expiresIn: 30000,
      };
      const result = OutgoingMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should validate challenge_verified message', () => {
      const message = {
        type: 'challenge_verified',
        timestamp: Date.now(),
      };
      const result = OutgoingMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should validate error message', () => {
      const message = {
        type: 'error',
        error: 'test_error',
      };
      const result = OutgoingMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should reject incoming message types', () => {
      const message = {
        type: 'ping',
      };
      const result = OutgoingMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
    });
  });

  describe('validateIncomingMessage', () => {
    it('should return parsed message for valid input', () => {
      const message = { type: 'ping' };
      const result = validateIncomingMessage(message);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('ping');
    });

    it('should return null for invalid input', () => {
      const message = { type: 'invalid' };
      const result = validateIncomingMessage(message);

      expect(result).toBeNull();
    });

    it('should return null for non-object input', () => {
      const result = validateIncomingMessage('not an object');
      expect(result).toBeNull();
    });
  });

  describe('validateIncomingMessageWithError', () => {
    it('should return success with data for valid message', () => {
      const message = { type: 'ping' };
      const result = validateIncomingMessageWithError(message);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('ping');
      }
    });

    it('should return detailed error for invalid message', () => {
      const message = { type: 'unknown_type' };
      const result = validateIncomingMessageWithError(message);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Message validation failed');
        expect(result.issues).toBeInstanceOf(Array);
        expect(result.issues.length).toBeGreaterThan(0);
      }
    });

    it('should provide path information in errors', () => {
      const message = {
        type: 'tool_execute',
        // Missing required fields
      };
      const result = validateIncomingMessageWithError(message);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some(issue => issue.path)).toBe(true);
      }
    });

    it('should handle completely invalid data', () => {
      const result = validateIncomingMessageWithError(null);

      expect(result.success).toBe(false);
    });
  });

  describe('Type Guard Functions', () => {
    describe('isPingMessage', () => {
      it('should identify ping message', () => {
        const message = { type: 'ping' as const };
        const result = IncomingMessageSchema.parse(message);
        expect(isPingMessage(result)).toBe(true);
      });

      it('should reject non-ping message', () => {
        const message = {
          type: 'tool_execute' as const,
          id: '123',
          serverName: 'server',
          toolName: 'tool',
        };
        const result = IncomingMessageSchema.parse(message);
        expect(isPingMessage(result)).toBe(false);
      });
    });

    describe('isChallengeResponseMessage', () => {
      it('should identify challenge_response message', () => {
        const message = {
          type: 'challenge_response' as const,
          response: 'a'.repeat(64),
        };
        const result = IncomingMessageSchema.parse(message);
        expect(isChallengeResponseMessage(result)).toBe(true);
      });

      it('should reject non-challenge_response message', () => {
        const message = { type: 'ping' as const };
        const result = IncomingMessageSchema.parse(message);
        expect(isChallengeResponseMessage(result)).toBe(false);
      });
    });

    describe('isToolExecuteMessage', () => {
      it('should identify tool_execute message', () => {
        const message = {
          type: 'tool_execute' as const,
          id: '123',
          serverName: 'server',
          toolName: 'tool',
        };
        const result = IncomingMessageSchema.parse(message);
        expect(isToolExecuteMessage(result)).toBe(true);
      });

      it('should reject non-tool_execute message', () => {
        const message = { type: 'ping' as const };
        const result = IncomingMessageSchema.parse(message);
        expect(isToolExecuteMessage(result)).toBe(false);
      });
    });

    describe('isToolResultMessage', () => {
      it('should identify tool_result message', () => {
        const message = {
          type: 'tool_result' as const,
          id: '123',
          success: true,
        };
        const result = IncomingMessageSchema.parse(message);
        expect(isToolResultMessage(result)).toBe(true);
      });

      it('should reject non-tool_result message', () => {
        const message = { type: 'ping' as const };
        const result = IncomingMessageSchema.parse(message);
        expect(isToolResultMessage(result)).toBe(false);
      });
    });
  });

  describe('Real-world Message Scenarios', () => {
    it('should handle complete tool execution flow', () => {
      // 1. Client sends ping
      const ping = validateIncomingMessage({ type: 'ping' });
      expect(ping).not.toBeNull();

      // 2. Client sends challenge response
      const challengeResponse = validateIncomingMessage({
        type: 'challenge_response',
        response: 'a'.repeat(64),
      });
      expect(challengeResponse).not.toBeNull();

      // 3. Client sends tool execute
      const toolExecute = validateIncomingMessage({
        type: 'tool_execute',
        id: 'req_1',
        serverName: 'filesystem',
        toolName: 'read-file',
        arguments: { path: '/test.txt' },
      });
      expect(toolExecute).not.toBeNull();

      // 4. Client sends tool result
      const toolResult = validateIncomingMessage({
        type: 'tool_result',
        id: 'req_1',
        success: true,
        result: { content: 'file contents' },
      });
      expect(toolResult).not.toBeNull();
    });

    it('should reject malformed messages gracefully', () => {
      const malformedMessages = [
        {},
        { type: null },
        { type: 123 },
        { type: 'tool_execute' }, // Missing required fields
        { type: 'challenge_response', response: 'too-short' },
        { type: 'tool_result', id: '123' }, // Missing success field
      ];

      malformedMessages.forEach(msg => {
        const result = validateIncomingMessage(msg);
        expect(result).toBeNull();
      });
    });
  });
});
