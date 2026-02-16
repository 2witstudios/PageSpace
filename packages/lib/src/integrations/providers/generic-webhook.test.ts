/**
 * Generic Webhook Provider Tests
 *
 * Validates the webhook provider config structure, tool definitions,
 * and integration with buildHttpRequest and convertToolSchemaToZod.
 */

import { describe, it, expect } from 'vitest';
import { genericWebhookProvider } from './generic-webhook';
import { buildHttpRequest } from '../execution/build-request';
import { convertToolSchemaToZod } from '../converter/ai-sdk';
import type { HttpExecutionConfig } from '../types';

describe('genericWebhookProvider', () => {
  describe('provider structure', () => {
    it('given the provider config, should have correct identity', () => {
      expect(genericWebhookProvider.id).toBe('generic-webhook');
      expect(genericWebhookProvider.name).toBe('Generic Webhook');
    });

    it('given the provider config, should use custom_header auth with webhook secret', () => {
      const { authMethod } = genericWebhookProvider;
      expect(authMethod.type).toBe('custom_header');
      if (authMethod.type !== 'custom_header') throw new Error('unexpected auth type');
      expect(authMethod.config.headers).toHaveLength(1);
      expect(authMethod.config.headers[0].name).toBe('X-Webhook-Secret');
      expect(authMethod.config.headers[0].credentialKey).toBe('webhookSecret');
    });

    it('given the provider config, should use placeholder base URL', () => {
      expect(genericWebhookProvider.baseUrl).toBe('https://placeholder.invalid');
    });

    it('given the provider config, should set User-Agent header', () => {
      expect(genericWebhookProvider.defaultHeaders).toEqual({
        'User-Agent': 'PageSpace-Webhook/1.0',
      });
    });

    it('given the provider config, should have credential schema with optional webhookSecret', () => {
      const schema = genericWebhookProvider.credentialSchema;
      expect(schema).toBeDefined();
      expect((schema as Record<string, unknown>).required).toEqual([]);
    });

    it('given the provider config, should rate limit at 60 req/min', () => {
      expect(genericWebhookProvider.rateLimit).toEqual({
        requests: 60,
        windowMs: 60_000,
      });
    });

    it('given the provider config, should have 3 tools', () => {
      expect(genericWebhookProvider.tools).toHaveLength(3);
    });
  });

  describe('send_webhook tool', () => {
    const tool = genericWebhookProvider.tools.find((t) => t.id === 'send_webhook')!;

    it('given the tool, should be a write category POST', () => {
      expect(tool.category).toBe('write');
      expect(tool.execution.type).toBe('http');
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      expect(config.method).toBe('POST');
      expect(config.bodyEncoding).toBe('json');
    });

    it('given the tool, should require body input', () => {
      expect((tool.inputSchema as { required: string[] }).required).toContain('body');
    });

    it('given body and path, should build correct POST request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { body: { event: 'deploy', status: 'success' }, path: 'events' };
      const baseUrl = 'https://hooks.example.com';

      const result = buildHttpRequest(config, input, baseUrl);

      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://hooks.example.com/events');
      expect(result.body).toBe('{"event":"deploy","status":"success"}');
    });

    it('given body without path, should POST to root URL', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { body: { ping: true } };
      const baseUrl = 'https://hooks.example.com';

      const result = buildHttpRequest(config, input, baseUrl);

      expect(result.url).toBe('https://hooks.example.com/');
    });
  });

  describe('send_get_webhook tool', () => {
    const tool = genericWebhookProvider.tools.find((t) => t.id === 'send_get_webhook')!;

    it('given the tool, should be a read category GET', () => {
      expect(tool.category).toBe('read');
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      expect(config.method).toBe('GET');
    });

    it('given no required inputs, should have empty required array', () => {
      expect((tool.inputSchema as { required: string[] }).required).toEqual([]);
    });

    it('given a path, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { path: 'status' };
      const baseUrl = 'https://hooks.example.com';

      const result = buildHttpRequest(config, input, baseUrl);

      expect(result.method).toBe('GET');
      expect(result.url).toBe('https://hooks.example.com/status');
      expect(result.body).toBeUndefined();
    });

    it('given no path, should build GET to root', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const result = buildHttpRequest(config, {}, 'https://hooks.example.com');

      expect(result.url).toBe('https://hooks.example.com/');
    });

    it('given path with question mark, should percent-encode it (not treated as query string)', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const result = buildHttpRequest(
        config,
        { path: 'status?key=value' },
        'https://hooks.example.com'
      );

      expect(result.url).toBe('https://hooks.example.com/status%3Fkey=value');
    });

    it('given path with multiple query-like params, should percent-encode the question mark', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const result = buildHttpRequest(
        config,
        { path: 'status?a=1&b=2' },
        'https://hooks.example.com'
      );

      expect(result.url).toBe('https://hooks.example.com/status%3Fa=1&b=2');
    });

    it('given path with spaces, should percent-encode them', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const result = buildHttpRequest(
        config,
        { path: 'hello world' },
        'https://hooks.example.com'
      );

      expect(result.url).toBe('https://hooks.example.com/hello%20world');
    });

    it('given path with hash, should percent-encode it (not treated as fragment)', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const result = buildHttpRequest(
        config,
        { path: 'status#section' },
        'https://hooks.example.com'
      );

      expect(result.url).toBe('https://hooks.example.com/status%23section');
    });

    it('given path with ampersand, should pass it through unencoded', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const result = buildHttpRequest(
        config,
        { path: 'data&more' },
        'https://hooks.example.com'
      );

      expect(result.url).toBe('https://hooks.example.com/data&more');
    });

    it('given path with slashes, should preserve path segments', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const result = buildHttpRequest(
        config,
        { path: 'api/v2/events' },
        'https://hooks.example.com'
      );

      expect(result.url).toBe('https://hooks.example.com/api/v2/events');
    });
  });

  describe('send_form_webhook tool', () => {
    const tool = genericWebhookProvider.tools.find((t) => t.id === 'send_form_webhook')!;

    it('given the tool, should be a write category POST with form encoding', () => {
      expect(tool.category).toBe('write');
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      expect(config.method).toBe('POST');
      expect(config.bodyEncoding).toBe('form');
    });

    it('given the tool, should require body input', () => {
      expect((tool.inputSchema as { required: string[] }).required).toContain('body');
    });

    it('given body and path, should build form-encoded request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { body: { channel: '#general', text: 'hello' }, path: 'notify' };
      const baseUrl = 'https://hooks.example.com';

      const result = buildHttpRequest(config, input, baseUrl);

      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://hooks.example.com/notify');
      expect(result.body).toBe('channel=%23general&text=hello');
    });
  });

  describe('schema compatibility', () => {
    it('given all tool input schemas, should convert to valid Zod schemas', () => {
      for (const tool of genericWebhookProvider.tools) {
        const zodSchema = convertToolSchemaToZod(tool.inputSchema);
        expect(zodSchema).toBeDefined();
        expect(zodSchema.parse).toBeTypeOf('function');
      }
    });
  });
});
