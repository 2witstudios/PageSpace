/**
 * Pure Tool Validation Tests
 *
 * Tests for isToolAllowed - a pure function that checks if a tool
 * is allowed given all permission layers.
 */

import { describe, it, expect } from 'vitest';
import { isToolAllowed } from './is-tool-allowed';
import type { ToolDefinition } from '../types';

// Helper to create minimal tool definitions for testing
const createTool = (id: string, category: 'read' | 'write' | 'admin' | 'dangerous' = 'read'): ToolDefinition => ({
  id,
  name: id,
  description: `Test tool: ${id}`,
  category,
  inputSchema: { type: 'object' },
  execution: { type: 'http', config: { method: 'GET', pathTemplate: '/test' } },
});

describe('isToolAllowed', () => {
  describe('provider tools check', () => {
    it('given a tool not in providers tool list, should return not allowed with reason', () => {
      const providerTools = [createTool('list_items'), createTool('get_item')];

      const result = isToolAllowed('unknown_tool', {
        providerTools,
        grantAllowedTools: null,
        grantDeniedTools: null,
        grantReadOnly: false,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not found');
    });

    it('given a tool in providers tool list, should proceed to grant checks', () => {
      const providerTools = [createTool('list_items')];

      const result = isToolAllowed('list_items', {
        providerTools,
        grantAllowedTools: null,
        grantDeniedTools: null,
        grantReadOnly: false,
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('grant allowedTools check', () => {
    it('given grant with null allowedTools, should allow all provider tools', () => {
      const providerTools = [
        createTool('list_items'),
        createTool('create_item', 'write'),
        createTool('delete_item', 'admin'),
      ];

      const resultList = isToolAllowed('list_items', {
        providerTools,
        grantAllowedTools: null,
        grantDeniedTools: null,
        grantReadOnly: false,
      });

      const resultCreate = isToolAllowed('create_item', {
        providerTools,
        grantAllowedTools: null,
        grantDeniedTools: null,
        grantReadOnly: false,
      });

      const resultDelete = isToolAllowed('delete_item', {
        providerTools,
        grantAllowedTools: null,
        grantDeniedTools: null,
        grantReadOnly: false,
      });

      expect(resultList.allowed).toBe(true);
      expect(resultCreate.allowed).toBe(true);
      expect(resultDelete.allowed).toBe(true);
    });

    it('given grant with specific allowedTools, should only allow listed tools', () => {
      const providerTools = [
        createTool('list_items'),
        createTool('get_item'),
        createTool('create_item', 'write'),
      ];

      const resultList = isToolAllowed('list_items', {
        providerTools,
        grantAllowedTools: ['list_items', 'get_item'],
        grantDeniedTools: null,
        grantReadOnly: false,
      });

      const resultCreate = isToolAllowed('create_item', {
        providerTools,
        grantAllowedTools: ['list_items', 'get_item'],
        grantDeniedTools: null,
        grantReadOnly: false,
      });

      expect(resultList.allowed).toBe(true);
      expect(resultCreate.allowed).toBe(false);
      expect(resultCreate.reason).toContain('not in allowed list');
    });

    it('given grant with empty allowedTools array, should deny all tools', () => {
      const providerTools = [createTool('list_items')];

      const result = isToolAllowed('list_items', {
        providerTools,
        grantAllowedTools: [],
        grantDeniedTools: null,
        grantReadOnly: false,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in allowed list');
    });
  });

  describe('grant deniedTools check', () => {
    it('given grant with deniedTools, should deny those tools even if in allowedTools', () => {
      const providerTools = [
        createTool('list_items'),
        createTool('delete_item', 'dangerous'),
      ];

      const result = isToolAllowed('delete_item', {
        providerTools,
        grantAllowedTools: null, // All tools allowed
        grantDeniedTools: ['delete_item'],
        grantReadOnly: false,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('explicitly denied');
    });

    it('given grant with deniedTools and specific allowedTools, should deny if in both', () => {
      const providerTools = [
        createTool('list_items'),
        createTool('dangerous_action', 'dangerous'),
      ];

      const result = isToolAllowed('dangerous_action', {
        providerTools,
        grantAllowedTools: ['list_items', 'dangerous_action'], // Explicitly allowed
        grantDeniedTools: ['dangerous_action'], // But also denied
        grantReadOnly: false,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('explicitly denied');
    });

    it('given null deniedTools, should not affect allowed tools', () => {
      const providerTools = [createTool('list_items')];

      const result = isToolAllowed('list_items', {
        providerTools,
        grantAllowedTools: null,
        grantDeniedTools: null,
        grantReadOnly: false,
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('readOnly check', () => {
    it('given grant with readOnly true, should deny tools with category write', () => {
      const providerTools = [
        createTool('list_items', 'read'),
        createTool('create_item', 'write'),
      ];

      const resultRead = isToolAllowed('list_items', {
        providerTools,
        grantAllowedTools: null,
        grantDeniedTools: null,
        grantReadOnly: true,
      });

      const resultWrite = isToolAllowed('create_item', {
        providerTools,
        grantAllowedTools: null,
        grantDeniedTools: null,
        grantReadOnly: true,
      });

      expect(resultRead.allowed).toBe(true);
      expect(resultWrite.allowed).toBe(false);
      expect(resultWrite.reason).toContain('read-only');
    });

    it('given grant with readOnly true, should deny tools with category admin', () => {
      const providerTools = [createTool('delete_all', 'admin')];

      const result = isToolAllowed('delete_all', {
        providerTools,
        grantAllowedTools: null,
        grantDeniedTools: null,
        grantReadOnly: true,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('read-only');
    });

    it('given grant with readOnly true, should deny tools with category dangerous', () => {
      const providerTools = [createTool('nuke_everything', 'dangerous')];

      const result = isToolAllowed('nuke_everything', {
        providerTools,
        grantAllowedTools: null,
        grantDeniedTools: null,
        grantReadOnly: true,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('read-only');
    });

    it('given grant with readOnly false, should allow write tools', () => {
      const providerTools = [createTool('create_item', 'write')];

      const result = isToolAllowed('create_item', {
        providerTools,
        grantAllowedTools: null,
        grantDeniedTools: null,
        grantReadOnly: false,
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('dangerous category check', () => {
    it('given tool with category dangerous, should require explicit allowedTools entry', () => {
      const providerTools = [createTool('dangerous_action', 'dangerous')];

      // With null allowedTools (all allowed) - should still require explicit
      const resultImplicit = isToolAllowed('dangerous_action', {
        providerTools,
        grantAllowedTools: null,
        grantDeniedTools: null,
        grantReadOnly: false,
      });

      // With explicit allowedTools entry
      const resultExplicit = isToolAllowed('dangerous_action', {
        providerTools,
        grantAllowedTools: ['dangerous_action'],
        grantDeniedTools: null,
        grantReadOnly: false,
      });

      expect(resultImplicit.allowed).toBe(false);
      expect(resultImplicit.reason).toContain('requires explicit');
      expect(resultExplicit.allowed).toBe(true);
    });

    it('given dangerous tool in deniedTools even with explicit allow, should deny', () => {
      const providerTools = [createTool('dangerous_action', 'dangerous')];

      const result = isToolAllowed('dangerous_action', {
        providerTools,
        grantAllowedTools: ['dangerous_action'],
        grantDeniedTools: ['dangerous_action'],
        grantReadOnly: false,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('explicitly denied');
    });
  });

  describe('combined checks', () => {
    it('given all conditions passing, should allow the tool', () => {
      const providerTools = [createTool('safe_read', 'read')];

      const result = isToolAllowed('safe_read', {
        providerTools,
        grantAllowedTools: ['safe_read'],
        grantDeniedTools: [],
        grantReadOnly: false,
      });

      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('given check order, should deny at first failure', () => {
      const providerTools = [createTool('write_action', 'write')];

      // Tool exists, is in allowed list, but grant is read-only
      const result = isToolAllowed('write_action', {
        providerTools,
        grantAllowedTools: ['write_action'],
        grantDeniedTools: null,
        grantReadOnly: true,
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('read-only');
    });
  });
});
