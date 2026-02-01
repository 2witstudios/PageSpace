/**
 * Type Definition Tests
 *
 * These tests verify that the type definitions compile correctly
 * and can be used as expected. TypeScript compilation IS the test.
 */

import { describe, it, expect } from 'vitest';
import type {
  AuthMethod,
  ToolExecution,
  ProviderType,
  HttpExecutionConfig,
  ToolDefinition,
  IntegrationProviderConfig,
  ConnectionStatus,
  ConnectionVisibility,
  ToolCategory,
  DriveRole,
} from './types';

describe('Integration Types', () => {
  describe('AuthMethod', () => {
    it('given oauth2 auth method, should compile with correct config', () => {
      const auth: AuthMethod = {
        type: 'oauth2',
        config: {
          authorizationUrl: 'https://example.com/oauth/authorize',
          tokenUrl: 'https://example.com/oauth/token',
          scopes: ['read', 'write'],
          pkceRequired: true,
        },
      };
      expect(auth.type).toBe('oauth2');
    });

    it('given api_key auth method, should compile with correct config', () => {
      const auth: AuthMethod = {
        type: 'api_key',
        config: {
          placement: 'header',
          paramName: 'X-API-Key',
          prefix: 'Api-Key ',
        },
      };
      expect(auth.type).toBe('api_key');
    });

    it('given bearer_token auth method, should compile with correct config', () => {
      const auth: AuthMethod = {
        type: 'bearer_token',
        config: {
          headerName: 'Authorization',
          prefix: 'Bearer ',
        },
      };
      expect(auth.type).toBe('bearer_token');
    });

    it('given basic_auth auth method, should compile with correct config', () => {
      const auth: AuthMethod = {
        type: 'basic_auth',
        config: {
          usernameField: 'username',
          passwordField: 'password',
        },
      };
      expect(auth.type).toBe('basic_auth');
    });

    it('given custom_header auth method, should compile with correct config', () => {
      const auth: AuthMethod = {
        type: 'custom_header',
        config: {
          headers: [
            { name: 'X-Custom', valueFrom: 'credential', credentialKey: 'apiKey' },
            { name: 'X-Static', valueFrom: 'static', staticValue: 'fixed-value' },
          ],
        },
      };
      expect(auth.type).toBe('custom_header');
    });

    it('given none auth method, should compile', () => {
      const auth: AuthMethod = { type: 'none' };
      expect(auth.type).toBe('none');
    });
  });

  describe('ToolExecution', () => {
    it('given http execution, should compile with correct config', () => {
      const exec: ToolExecution = {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/api/v1/resources/{id}',
          queryParams: { limit: '10' },
          headers: { 'Content-Type': 'application/json' },
          bodyTemplate: { name: { $param: 'name' } },
          bodyEncoding: 'json',
        },
      };
      expect(exec.type).toBe('http');
    });

    it('given graphql execution, should compile with correct config', () => {
      const exec: ToolExecution = {
        type: 'graphql',
        config: {
          query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
          variables: { id: { $param: 'userId' } },
          operationName: 'GetUser',
        },
      };
      expect(exec.type).toBe('graphql');
    });

    it('given function execution, should compile with handler', () => {
      const exec: ToolExecution = {
        type: 'function',
        handler: 'github.listRepos',
      };
      expect(exec.type).toBe('function');
    });

    it('given chain execution, should compile with steps', () => {
      const exec: ToolExecution = {
        type: 'chain',
        steps: [
          { type: 'http', config: { method: 'GET', pathTemplate: '/first' } },
          { type: 'http', config: { method: 'POST', pathTemplate: '/second' } },
        ],
      };
      expect(exec.type).toBe('chain');
    });
  });

  describe('ProviderType', () => {
    it('given all provider types, should be valid', () => {
      const types: ProviderType[] = ['builtin', 'openapi', 'custom', 'mcp', 'webhook'];
      expect(types).toHaveLength(5);
    });
  });

  describe('HttpExecutionConfig', () => {
    it('given full config, should include all fields', () => {
      const config: HttpExecutionConfig = {
        method: 'POST',
        pathTemplate: '/api/{version}/users/{userId}',
        queryParams: {
          format: 'json',
          includeDeleted: { $param: 'includeDeleted', transform: 'boolean' },
        },
        headers: {
          'X-Request-ID': { $param: 'requestId' },
        },
        bodyTemplate: {
          user: {
            name: { $param: 'name' },
            email: { $param: 'email' },
          },
        },
        bodyEncoding: 'json',
      };
      expect(config.method).toBe('POST');
      expect(config.pathTemplate).toContain('{version}');
    });
  });

  describe('ToolDefinition', () => {
    it('given full tool definition, should include all required fields', () => {
      const tool: ToolDefinition = {
        id: 'create_issue',
        name: 'Create Issue',
        description: 'Creates a new issue in the repository',
        category: 'write',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['title'],
        },
        execution: {
          type: 'http',
          config: {
            method: 'POST',
            pathTemplate: '/repos/{owner}/{repo}/issues',
          },
        },
        outputTransform: {
          extract: '$.id',
          mapping: { issueId: 'id', issueUrl: 'html_url' },
          maxLength: 1000,
        },
        rateLimit: {
          requests: 30,
          windowMs: 60000,
        },
      };
      expect(tool.id).toBe('create_issue');
      expect(tool.category).toBe('write');
    });
  });

  describe('IntegrationProviderConfig', () => {
    it('given full provider config, should describe complete API integration', () => {
      const provider: IntegrationProviderConfig = {
        id: 'github',
        name: 'GitHub',
        description: 'GitHub API integration',
        iconUrl: 'https://github.com/favicon.ico',
        documentationUrl: 'https://docs.github.com/rest',
        authMethod: {
          type: 'oauth2',
          config: {
            authorizationUrl: 'https://github.com/login/oauth/authorize',
            tokenUrl: 'https://github.com/login/oauth/access_token',
            scopes: ['repo', 'read:user'],
          },
        },
        baseUrl: 'https://api.github.com',
        defaultHeaders: {
          Accept: 'application/vnd.github.v3+json',
        },
        tools: [
          {
            id: 'list_repos',
            name: 'List Repositories',
            description: 'List repositories for the authenticated user',
            category: 'read',
            inputSchema: { type: 'object', properties: {} },
            execution: {
              type: 'http',
              config: { method: 'GET', pathTemplate: '/user/repos' },
            },
          },
        ],
        credentialSchema: {
          type: 'object',
          properties: {
            accessToken: { type: 'string' },
          },
        },
        healthCheck: {
          endpoint: '/user',
          expectedStatus: 200,
        },
      };
      expect(provider.id).toBe('github');
      expect(provider.tools).toHaveLength(1);
    });
  });

  describe('ConnectionStatus', () => {
    it('given all connection statuses, should be valid', () => {
      const statuses: ConnectionStatus[] = ['active', 'expired', 'error', 'pending', 'revoked'];
      expect(statuses).toHaveLength(5);
    });
  });

  describe('ConnectionVisibility', () => {
    it('given all visibility options, should be valid', () => {
      const visibilities: ConnectionVisibility[] = ['private', 'owned_drives', 'all_drives'];
      expect(visibilities).toHaveLength(3);
    });
  });

  describe('ToolCategory', () => {
    it('given all tool categories, should be valid', () => {
      const categories: ToolCategory[] = ['read', 'write', 'admin', 'dangerous'];
      expect(categories).toHaveLength(4);
    });
  });

  describe('DriveRole', () => {
    it('given all drive roles, should be valid', () => {
      const roles: DriveRole[] = ['OWNER', 'ADMIN', 'MEMBER'];
      expect(roles).toHaveLength(3);
    });
  });
});
