/**
 * MCP Timeout Configuration Tests
 * Tests for configurable tool execution timeouts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MCP_CONSTANTS,
  validateTimeout,
  getEffectiveTimeout,
  getTimeoutFromEnv,
  type MCPServerConfig,
} from '../mcp-types';

describe('MCP Timeout Configuration', () => {
  // Save original env
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.MCP_TOOL_TIMEOUT_MS;
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.MCP_TOOL_TIMEOUT_MS = originalEnv;
    } else {
      delete process.env.MCP_TOOL_TIMEOUT_MS;
    }
  });

  describe('validateTimeout', () => {
    it('should return value within valid range unchanged', () => {
      expect(validateTimeout(30000)).toBe(30000);
      expect(validateTimeout(60000)).toBe(60000);
      expect(validateTimeout(5000)).toBe(5000);
    });

    it('should clamp values below minimum to minimum', () => {
      expect(validateTimeout(500)).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MIN);
      expect(validateTimeout(0)).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MIN);
      expect(validateTimeout(-1000)).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MIN);
    });

    it('should clamp values above maximum to maximum', () => {
      expect(validateTimeout(400000)).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MAX);
      expect(validateTimeout(600000)).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MAX);
      expect(validateTimeout(1000000)).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MAX);
    });

    it('should handle boundary values correctly', () => {
      expect(validateTimeout(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MIN)).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MIN);
      expect(validateTimeout(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MAX)).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MAX);
    });
  });

  describe('getEffectiveTimeout', () => {
    it('should return server-specific timeout when provided', () => {
      const config: MCPServerConfig = {
        command: 'test',
        args: [],
        timeout: 45000,
      };
      expect(getEffectiveTimeout(config)).toBe(45000);
    });

    it('should return default timeout when not specified', () => {
      const config: MCPServerConfig = {
        command: 'test',
        args: [],
      };
      expect(getEffectiveTimeout(config)).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MS);
    });

    it('should validate and clamp custom timeout', () => {
      const configTooLow: MCPServerConfig = {
        command: 'test',
        args: [],
        timeout: 500,
      };
      expect(getEffectiveTimeout(configTooLow)).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MIN);

      const configTooHigh: MCPServerConfig = {
        command: 'test',
        args: [],
        timeout: 500000,
      };
      expect(getEffectiveTimeout(configTooHigh)).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MAX);
    });

    it('should handle invalid timeout values', () => {
      const configNegative: MCPServerConfig = {
        command: 'test',
        args: [],
        timeout: -1000,
      };
      expect(getEffectiveTimeout(configNegative)).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MIN);

      const configZero: MCPServerConfig = {
        command: 'test',
        args: [],
        timeout: 0,
      };
      expect(getEffectiveTimeout(configZero)).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MS);
    });
  });

  describe('getTimeoutFromEnv', () => {
    it('should return environment variable timeout when valid', () => {
      process.env.MCP_TOOL_TIMEOUT_MS = '45000';
      expect(getTimeoutFromEnv()).toBe(45000);
    });

    it('should return default when environment variable not set', () => {
      delete process.env.MCP_TOOL_TIMEOUT_MS;
      expect(getTimeoutFromEnv()).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MS);
    });

    it('should validate and clamp environment variable values', () => {
      process.env.MCP_TOOL_TIMEOUT_MS = '500';
      expect(getTimeoutFromEnv()).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MIN);

      process.env.MCP_TOOL_TIMEOUT_MS = '500000';
      expect(getTimeoutFromEnv()).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MAX);
    });

    it('should return default for invalid environment variable values', () => {
      process.env.MCP_TOOL_TIMEOUT_MS = 'invalid';
      expect(getTimeoutFromEnv()).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MS);

      process.env.MCP_TOOL_TIMEOUT_MS = '';
      expect(getTimeoutFromEnv()).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MS);

      process.env.MCP_TOOL_TIMEOUT_MS = '-1000';
      expect(getTimeoutFromEnv()).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MS);
    });
  });

  describe('Timeout Ranges', () => {
    it('should enforce minimum timeout of 1 second', () => {
      expect(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MIN).toBe(1000);
    });

    it('should enforce maximum timeout of 5 minutes', () => {
      expect(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MAX).toBe(300000);
    });

    it('should have default timeout of 30 seconds', () => {
      expect(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MS).toBe(30000);
    });

    it('should have consistent defaults within allowed range', () => {
      expect(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MS).toBeGreaterThanOrEqual(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MIN);
      expect(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MS).toBeLessThanOrEqual(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MAX);
    });
  });

  describe('Real-world Scenarios', () => {
    it('should handle fast tools (short timeout)', () => {
      const config: MCPServerConfig = {
        command: 'fast-tool',
        args: [],
        timeout: 5000, // 5 seconds
      };
      expect(getEffectiveTimeout(config)).toBe(5000);
    });

    it('should handle slow tools (long timeout)', () => {
      const config: MCPServerConfig = {
        command: 'slow-tool',
        args: [],
        timeout: 120000, // 2 minutes
      };
      expect(getEffectiveTimeout(config)).toBe(120000);
    });

    it('should handle extremely slow tools (capped at maximum)', () => {
      const config: MCPServerConfig = {
        command: 'very-slow-tool',
        args: [],
        timeout: 600000, // 10 minutes - too long
      };
      expect(getEffectiveTimeout(config)).toBe(MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MAX);
    });
  });
});
