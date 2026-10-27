/**
 * WebSocket Message Schema Validation Tests
 * Tests for Zod schema validation of all message types
 */

import { describe, it, expect } from 'vitest';
import {
  PingMessageSchema,
  PongMessageSchema,
  ToolExecuteMessageSchema,
  ToolResultMessageSchema,
  ErrorMessageSchema,
  FetchRequestMessageSchema,
  FetchResponseStartMessageSchema,
  FetchResponseChunkMessageSchema,
  FetchResponseEndMessageSchema,
  FetchResponseErrorMessageSchema,
  IncomingMessageSchema,
  OutgoingMessageSchema,
  validateIncomingMessage,
  validateIncomingMessageWithError,
  isPingMessage,
  isToolExecuteMessage,
  isToolResultMessage,
  isFetchResponseStartMessage,
  isFetchResponseChunkMessage,
  isFetchResponseEndMessage,
  isFetchResponseErrorMessage,
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

  // Note: Challenge schema tests removed - auth migrated to opaque session tokens

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

  describe('FetchResponseStartMessageSchema', () => {
    it('should validate valid fetch response start', () => {
      const result = FetchResponseStartMessageSchema.safeParse({
        type: 'fetch_response_start',
        id: 'req_1',
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing status', () => {
      const result = FetchResponseStartMessageSchema.safeParse({
        type: 'fetch_response_start',
        id: 'req_1',
        statusText: 'OK',
        headers: {},
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-string header values', () => {
      const result = FetchResponseStartMessageSchema.safeParse({
        type: 'fetch_response_start',
        id: 'req_1',
        status: 200,
        statusText: 'OK',
        headers: { 'content-length': 42 },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('FetchResponseChunkMessageSchema', () => {
    it('should validate valid chunk message', () => {
      const result = FetchResponseChunkMessageSchema.safeParse({
        type: 'fetch_response_chunk',
        id: 'req_1',
        chunk: 'base64encodeddata==',
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing chunk', () => {
      const result = FetchResponseChunkMessageSchema.safeParse({
        type: 'fetch_response_chunk',
        id: 'req_1',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('FetchResponseEndMessageSchema', () => {
    it('should validate valid end message', () => {
      const result = FetchResponseEndMessageSchema.safeParse({
        type: 'fetch_response_end',
        id: 'req_1',
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing id', () => {
      const result = FetchResponseEndMessageSchema.safeParse({
        type: 'fetch_response_end',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('FetchResponseErrorMessageSchema', () => {
    it('should validate valid error message', () => {
      const result = FetchResponseErrorMessageSchema.safeParse({
        type: 'fetch_response_error',
        id: 'req_1',
        error: 'Connection refused',
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing error', () => {
      const result = FetchResponseErrorMessageSchema.safeParse({
        type: 'fetch_response_error',
        id: 'req_1',
      });
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

    // Note: challenge_response test removed - no longer part of IncomingMessageSchema
    // Auth is now via opaque session tokens

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

    it('should validate fetch_response_start message', () => {
      const result = IncomingMessageSchema.safeParse({
        type: 'fetch_response_start',
        id: 'req_1',
        status: 200,
        statusText: 'OK',
        headers: {},
      });
      expect(result.success).toBe(true);
    });

    it('should validate fetch_response_chunk message', () => {
      const result = IncomingMessageSchema.safeParse({
        type: 'fetch_response_chunk',
        id: 'req_1',
        chunk: 'data',
      });
      expect(result.success).toBe(true);
    });

    it('should validate fetch_response_end message', () => {
      const result = IncomingMessageSchema.safeParse({
        type: 'fetch_response_end',
        id: 'req_1',
      });
      expect(result.success).toBe(true);
    });

    it('should validate fetch_response_error message', () => {
      const result = IncomingMessageSchema.safeParse({
        type: 'fetch_response_error',
        id: 'req_1',
        error: 'Connection refused',
      });
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

    // Note: challenge and challenge_verified tests removed - auth migrated to opaque session tokens

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

    // Note: isChallengeResponseMessage tests removed - challenge_response no longer in IncomingMessageSchema
    // Auth is now via opaque session tokens, not challenge-response

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

    describe('isFetchResponseStartMessage', () => {
      it('should identify fetch_response_start message', () => {
        const message = {
          type: 'fetch_response_start' as const,
          id: '123',
          status: 200,
          statusText: 'OK',
          headers: {},
        };
        const result = IncomingMessageSchema.parse(message);
        expect(isFetchResponseStartMessage(result)).toBe(true);
      });

      it('should reject non-fetch_response_start message', () => {
        const message = { type: 'ping' as const };
        const result = IncomingMessageSchema.parse(message);
        expect(isFetchResponseStartMessage(result)).toBe(false);
      });
    });

    describe('isFetchResponseChunkMessage', () => {
      it('should identify fetch_response_chunk message', () => {
        const message = {
          type: 'fetch_response_chunk' as const,
          id: '123',
          chunk: 'data',
        };
        const result = IncomingMessageSchema.parse(message);
        expect(isFetchResponseChunkMessage(result)).toBe(true);
      });

      it('should reject non-fetch_response_chunk message', () => {
        const message = { type: 'ping' as const };
        const result = IncomingMessageSchema.parse(message);
        expect(isFetchResponseChunkMessage(result)).toBe(false);
      });
    });

    describe('isFetchResponseEndMessage', () => {
      it('should identify fetch_response_end message', () => {
        const message = {
          type: 'fetch_response_end' as const,
          id: '123',
        };
        const result = IncomingMessageSchema.parse(message);
        expect(isFetchResponseEndMessage(result)).toBe(true);
      });

      it('should reject non-fetch_response_end message', () => {
        const message = { type: 'ping' as const };
        const result = IncomingMessageSchema.parse(message);
        expect(isFetchResponseEndMessage(result)).toBe(false);
      });
    });

    describe('isFetchResponseErrorMessage', () => {
      it('should identify fetch_response_error message', () => {
        const message = {
          type: 'fetch_response_error' as const,
          id: '123',
          error: 'Connection refused',
        };
        const result = IncomingMessageSchema.parse(message);
        expect(isFetchResponseErrorMessage(result)).toBe(true);
      });

      it('should reject non-fetch_response_error message', () => {
        const message = { type: 'ping' as const };
        const result = IncomingMessageSchema.parse(message);
        expect(isFetchResponseErrorMessage(result)).toBe(false);
      });
    });
  });

  describe('Real-world Message Scenarios', () => {
    it('should handle complete tool execution flow', () => {
      // 1. Client sends ping
      const ping = validateIncomingMessage({ type: 'ping' });
      expect(ping).not.toBeNull();

      // Note: challenge_response step removed - auth is via opaque session tokens

      // 2. Client sends tool execute
      const toolExecute = validateIncomingMessage({
        type: 'tool_execute',
        id: 'req_1',
        serverName: 'filesystem',
        toolName: 'read-file',
        arguments: { path: '/test.txt' },
      });
      expect(toolExecute).not.toBeNull();

      // 3. Client sends tool result
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
        { type: 'tool_result', id: '123' }, // Missing success field
      ];

      malformedMessages.forEach(msg => {
        const result = validateIncomingMessage(msg);
        expect(result).toBeNull();
      });
    });
  });

  describe('FetchRequestMessageSchema', () => {
    it('should validate a complete fetch request', () => {
      const msg = {
        type: 'fetch_request',
        id: 'req-1',
        url: 'http://localhost:11434/api/chat',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: btoa('{"model":"llama3"}'),
      };
      expect(FetchRequestMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('should validate without optional body', () => {
      const msg = {
        type: 'fetch_request',
        id: 'req-1',
        url: 'http://localhost:11434/v1/models',
        method: 'GET',
        headers: {},
      };
      expect(FetchRequestMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('should reject missing url', () => {
      const msg = { type: 'fetch_request', id: 'req-1', method: 'GET', headers: {} };
      expect(FetchRequestMessageSchema.safeParse(msg).success).toBe(false);
    });

    it('should reject missing method', () => {
      const msg = { type: 'fetch_request', id: 'req-1', url: 'http://localhost', headers: {} };
      expect(FetchRequestMessageSchema.safeParse(msg).success).toBe(false);
    });
  });

  describe('FetchResponseStartMessageSchema', () => {
    it('should validate valid response start', () => {
      const msg = {
        type: 'fetch_response_start',
        id: 'req-1',
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      };
      expect(FetchResponseStartMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('should reject missing status', () => {
      const msg = { type: 'fetch_response_start', id: 'req-1', statusText: 'OK', headers: {} };
      expect(FetchResponseStartMessageSchema.safeParse(msg).success).toBe(false);
    });

    it('should reject non-number status', () => {
      const msg = {
        type: 'fetch_response_start',
        id: 'req-1',
        status: '200',
        statusText: 'OK',
        headers: {},
      };
      expect(FetchResponseStartMessageSchema.safeParse(msg).success).toBe(false);
    });
  });

  describe('FetchResponseChunkMessageSchema', () => {
    it('should validate valid chunk', () => {
      const msg = {
        type: 'fetch_response_chunk',
        id: 'req-1',
        chunk: btoa('some data'),
      };
      expect(FetchResponseChunkMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('should reject missing chunk', () => {
      const msg = { type: 'fetch_response_chunk', id: 'req-1' };
      expect(FetchResponseChunkMessageSchema.safeParse(msg).success).toBe(false);
    });
  });

  describe('FetchResponseEndMessageSchema', () => {
    it('should validate valid end message', () => {
      const msg = { type: 'fetch_response_end', id: 'req-1' };
      expect(FetchResponseEndMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('should reject missing id', () => {
      const msg = { type: 'fetch_response_end' };
      expect(FetchResponseEndMessageSchema.safeParse(msg).success).toBe(false);
    });
  });

  describe('FetchResponseErrorMessageSchema', () => {
    it('should validate valid error message', () => {
      const msg = { type: 'fetch_response_error', id: 'req-1', error: 'Connection refused' };
      expect(FetchResponseErrorMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('should reject missing error field', () => {
      const msg = { type: 'fetch_response_error', id: 'req-1' };
      expect(FetchResponseErrorMessageSchema.safeParse(msg).success).toBe(false);
    });
  });

  describe('Fetch messages in discriminated unions', () => {
    it('should accept fetch_response_start in IncomingMessageSchema', () => {
      const msg = {
        type: 'fetch_response_start',
        id: 'req-1',
        status: 200,
        statusText: 'OK',
        headers: {},
      };
      expect(IncomingMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('should accept fetch_response_chunk in IncomingMessageSchema', () => {
      const msg = { type: 'fetch_response_chunk', id: 'req-1', chunk: btoa('data') };
      expect(IncomingMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('should accept fetch_response_end in IncomingMessageSchema', () => {
      const msg = { type: 'fetch_response_end', id: 'req-1' };
      expect(IncomingMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('should accept fetch_response_error in IncomingMessageSchema', () => {
      const msg = { type: 'fetch_response_error', id: 'req-1', error: 'fail' };
      expect(IncomingMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('should accept fetch_request in OutgoingMessageSchema', () => {
      const msg = {
        type: 'fetch_request',
        id: 'req-1',
        url: 'http://localhost:11434/api/chat',
        method: 'POST',
        headers: {},
      };
      expect(OutgoingMessageSchema.safeParse(msg).success).toBe(true);
    });
  });

  describe('Fetch Type Guard Functions', () => {
    it('isFetchResponseStartMessage identifies correct type', () => {
      const msg = IncomingMessageSchema.parse({
        type: 'fetch_response_start',
        id: 'req-1',
        status: 200,
        statusText: 'OK',
        headers: {},
      });
      expect(isFetchResponseStartMessage(msg)).toBe(true);
      expect(isFetchResponseChunkMessage(msg)).toBe(false);
    });

    it('isFetchResponseChunkMessage identifies correct type', () => {
      const msg = IncomingMessageSchema.parse({
        type: 'fetch_response_chunk',
        id: 'req-1',
        chunk: btoa('data'),
      });
      expect(isFetchResponseChunkMessage(msg)).toBe(true);
      expect(isFetchResponseEndMessage(msg)).toBe(false);
    });

    it('isFetchResponseEndMessage identifies correct type', () => {
      const msg = IncomingMessageSchema.parse({
        type: 'fetch_response_end',
        id: 'req-1',
      });
      expect(isFetchResponseEndMessage(msg)).toBe(true);
      expect(isFetchResponseErrorMessage(msg)).toBe(false);
    });

    it('isFetchResponseErrorMessage identifies correct type', () => {
      const msg = IncomingMessageSchema.parse({
        type: 'fetch_response_error',
        id: 'req-1',
        error: 'fail',
      });
      expect(isFetchResponseErrorMessage(msg)).toBe(true);
      expect(isFetchResponseStartMessage(msg)).toBe(false);
    });

    it('existing type guards reject fetch message types', () => {
      const msg = IncomingMessageSchema.parse({
        type: 'fetch_response_start',
        id: 'req-1',
        status: 200,
        statusText: 'OK',
        headers: {},
      });
      expect(isPingMessage(msg)).toBe(false);
      expect(isToolExecuteMessage(msg)).toBe(false);
      expect(isToolResultMessage(msg)).toBe(false);
    });
  });
});
