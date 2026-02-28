/**
 * Slack Provider Tests
 *
 * Validates the Slack provider config structure, tool definitions,
 * rate limits, and integration with buildHttpRequest and convertToolSchemaToZod.
 */

import { describe, it, expect } from 'vitest';
import { slackProvider } from './slack';
import { buildHttpRequest } from '../execution/build-request';
import { convertToolSchemaToZod } from '../converter/ai-sdk';
import type { HttpExecutionConfig } from '../types';

describe('slackProvider', () => {
  describe('provider structure', () => {
    it('given the provider config, should have correct identity', () => {
      expect(slackProvider.id).toBe('slack');
      expect(slackProvider.name).toBe('Slack');
    });

    it('given the provider config, should use OAuth2 auth with correct Slack scopes', () => {
      const { authMethod } = slackProvider;
      expect(authMethod.type).toBe('oauth2');
      if (authMethod.type !== 'oauth2') throw new Error('unexpected auth type');
      expect(authMethod.config.scopes).toContain('channels:read');
      expect(authMethod.config.scopes).toContain('channels:history');
      expect(authMethod.config.scopes).toContain('groups:read');
      expect(authMethod.config.scopes).toContain('groups:history');
      expect(authMethod.config.scopes).toContain('chat:write');
      expect(authMethod.config.scopes).toContain('users:read');
      expect(authMethod.config.scopes).toContain('search:read');
    });

    it('given the provider config, should not require PKCE', () => {
      const { authMethod } = slackProvider;
      if (authMethod.type !== 'oauth2') throw new Error('unexpected auth type');
      expect(authMethod.config.pkceRequired).toBe(false);
    });

    it('given the provider config, should have correct OAuth2 URLs including revoke', () => {
      const { authMethod } = slackProvider;
      if (authMethod.type !== 'oauth2') throw new Error('unexpected auth type');
      expect(authMethod.config.authorizationUrl).toBe('https://slack.com/oauth/v2/authorize');
      expect(authMethod.config.tokenUrl).toBe('https://slack.com/api/oauth.v2.access');
      expect(authMethod.config.revokeUrl).toBe('https://slack.com/api/auth.revoke');
    });

    it('given the provider config, should target Slack API with correct headers', () => {
      expect(slackProvider.baseUrl).toBe('https://slack.com/api');
      expect(slackProvider.defaultHeaders).toEqual({
        'Content-Type': 'application/json; charset=utf-8',
      });
    });

    it('given the provider config, should have health check on auth.test', () => {
      expect(slackProvider.healthCheck).toEqual({
        endpoint: '/auth.test',
        expectedStatus: 200,
      });
    });

    it('given the provider config, should require accessToken in credential schema', () => {
      const schema = slackProvider.credentialSchema as Record<string, unknown>;
      expect(schema).toBeDefined();
      expect((schema.required as string[])).toContain('accessToken');
    });

    it('given the provider config, should rate limit at 30 req/min', () => {
      expect(slackProvider.rateLimit).toEqual({
        requests: 30,
        windowMs: 60_000,
      });
    });

    it('given the provider config, should have 5 tools', () => {
      expect(slackProvider.tools).toHaveLength(5);
    });
  });

  describe('tool categories', () => {
    it('given read tools, should all be category read', () => {
      const readToolIds = ['list_channels', 'list_messages', 'get_user_info', 'search_messages'];
      for (const id of readToolIds) {
        const tool = slackProvider.tools.find((t) => t.id === id)!;
        expect(tool.category).toBe('read');
      }
    });

    it('given write tools, should all be category write', () => {
      const writeToolIds = ['send_message'];
      for (const id of writeToolIds) {
        const tool = slackProvider.tools.find((t) => t.id === id)!;
        expect(tool.category).toBe('write');
      }
    });

    it('given write tools, should have tighter rate limits (10/min)', () => {
      const writeToolIds = ['send_message'];
      for (const id of writeToolIds) {
        const tool = slackProvider.tools.find((t) => t.id === id)!;
        expect(tool.rateLimit).toEqual({ requests: 10, windowMs: 60_000 });
      }
    });

    it('given read tools, should not have tool-level rate limits', () => {
      const readToolIds = ['list_channels', 'list_messages', 'get_user_info', 'search_messages'];
      for (const id of readToolIds) {
        const tool = slackProvider.tools.find((t) => t.id === id)!;
        expect(tool.rateLimit).toBeUndefined();
      }
    });
  });

  describe('response validation', () => {
    it('given Slack tools, should validate ok=true and read provider error messages', () => {
      for (const tool of slackProvider.tools) {
        expect(tool.responseValidation).toEqual({
          success: { path: '$.ok', equals: true },
          errorPath: '$.error',
        });
      }
    });
  });

  describe('list_channels tool', () => {
    const tool = slackProvider.tools.find((t) => t.id === 'list_channels')!;

    it('given no required params, should have empty required array', () => {
      expect((tool.inputSchema as { required: string[] }).required).toEqual([]);
    });

    it('given optional query params, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { limit: 100, cursor: 'abc123' };

      const result = buildHttpRequest(config, input, 'https://slack.com/api');

      expect(result.method).toBe('GET');
      expect(result.url).toContain('/conversations.list');
      expect(result.url).toContain('limit=100');
      expect(result.url).toContain('cursor=abc123');
      expect(result.body).toBeUndefined();
    });

    it('given no params, should build request without query string params', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const result = buildHttpRequest(config, {}, 'https://slack.com/api');

      expect(result.url).toBe('https://slack.com/api/conversations.list');
    });

    it('given the tool, should have output transform with mapping and maxLength', () => {
      expect(tool.outputTransform).toBeDefined();
      expect(tool.outputTransform!.extract).toBe('$.channels');
      expect(tool.outputTransform!.mapping).toHaveProperty('id');
      expect(tool.outputTransform!.mapping).toHaveProperty('name');
      expect(tool.outputTransform!.maxLength).toBe(500);
    });
  });

  describe('send_message tool', () => {
    const tool = slackProvider.tools.find((t) => t.id === 'send_message')!;

    it('given the tool, should require channel and text', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toContain('channel');
      expect(required).toContain('text');
    });

    it('given required and optional params, should build correct POST request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        channel: 'C1234567890',
        text: 'Hello from PageSpace!',
        thread_ts: '1234567890.123456',
      };

      const result = buildHttpRequest(config, input, 'https://slack.com/api');

      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://slack.com/api/chat.postMessage');

      const body = JSON.parse(result.body!);
      expect(body.channel).toBe('C1234567890');
      expect(body.text).toBe('Hello from PageSpace!');
      expect(body.thread_ts).toBe('1234567890.123456');
    });

    it('given only required params, should omit optional body fields', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { channel: 'C1234567890', text: 'Hello!' };

      const result = buildHttpRequest(config, input, 'https://slack.com/api');
      const body = JSON.parse(result.body!);

      expect(body.channel).toBe('C1234567890');
      expect(body.text).toBe('Hello!');
      expect(body).not.toHaveProperty('thread_ts');
    });

    it('given the tool, should have output transform with mapping', () => {
      expect(tool.outputTransform).toBeDefined();
      expect(tool.outputTransform!.mapping).toHaveProperty('ts');
      expect(tool.outputTransform!.mapping).toHaveProperty('channel');
    });
  });

  describe('list_messages tool', () => {
    const tool = slackProvider.tools.find((t) => t.id === 'list_messages')!;

    it('given the tool, should require channel', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toContain('channel');
    });

    it('given channel and optional params, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { channel: 'C1234567890', limit: 20, cursor: 'next_page' };

      const result = buildHttpRequest(config, input, 'https://slack.com/api');

      expect(result.method).toBe('GET');
      expect(result.url).toContain('/conversations.history');
      expect(result.url).toContain('channel=C1234567890');
      expect(result.url).toContain('limit=20');
      expect(result.url).toContain('cursor=next_page');
    });
  });

  describe('get_user_info tool', () => {
    const tool = slackProvider.tools.find((t) => t.id === 'get_user_info')!;

    it('given the tool, should require user', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toContain('user');
    });

    it('given user ID, should build correct GET request with query param', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { user: 'U1234567890' };

      const result = buildHttpRequest(config, input, 'https://slack.com/api');

      expect(result.method).toBe('GET');
      expect(result.url).toContain('/users.info');
      expect(result.url).toContain('user=U1234567890');
    });

    it('given the tool, should have output transform extracting user object', () => {
      expect(tool.outputTransform).toBeDefined();
      expect(tool.outputTransform!.extract).toBe('$.user');
    });
  });

  describe('search_messages tool', () => {
    const tool = slackProvider.tools.find((t) => t.id === 'search_messages')!;

    it('given the tool, should require query', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toContain('query');
    });

    it('given query and optional params, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { query: 'deployment issue', sort: 'timestamp', count: 10 };

      const result = buildHttpRequest(config, input, 'https://slack.com/api');

      expect(result.method).toBe('GET');
      expect(result.url).toContain('/search.messages');
      expect(result.url).toContain('query=deployment+issue');
      expect(result.url).toContain('sort=timestamp');
      expect(result.url).toContain('count=10');
    });

    it('given the tool, should have output transform extracting messages', () => {
      expect(tool.outputTransform).toBeDefined();
      expect(tool.outputTransform!.extract).toBe('$.messages.matches');
    });
  });

  describe('schema compatibility', () => {
    it('given all tool input schemas, should convert to valid Zod schemas', () => {
      for (const tool of slackProvider.tools) {
        const zodSchema = convertToolSchemaToZod(tool.inputSchema);
        expect(zodSchema).toBeDefined();
        expect(zodSchema.parse).toBeTypeOf('function');
      }
    });
  });
});
