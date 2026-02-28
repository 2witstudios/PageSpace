/**
 * Notion Provider Tests
 *
 * Validates the Notion provider config structure, tool definitions,
 * rate limits, and integration with buildHttpRequest and convertToolSchemaToZod.
 */

import { describe, it, expect } from 'vitest';
import { notionProvider } from './notion';
import { buildHttpRequest } from '../execution/build-request';
import { convertToolSchemaToZod } from '../converter/ai-sdk';
import type { HttpExecutionConfig } from '../types';

describe('notionProvider', () => {
  describe('provider structure', () => {
    it('given the provider config, should have correct identity', () => {
      expect(notionProvider.id).toBe('notion');
      expect(notionProvider.name).toBe('Notion');
    });

    it('given the provider config, should use OAuth2 auth', () => {
      const { authMethod } = notionProvider;
      expect(authMethod.type).toBe('oauth2');
      if (authMethod.type !== 'oauth2') throw new Error('unexpected auth type');
      expect(authMethod.config.scopes).toEqual([]);
      expect(authMethod.config.pkceRequired).toBe(false);
    });

    it('given the provider config, should have correct OAuth2 URLs', () => {
      const { authMethod } = notionProvider;
      if (authMethod.type !== 'oauth2') throw new Error('unexpected auth type');
      expect(authMethod.config.authorizationUrl).toBe(
        'https://api.notion.com/v1/oauth/authorize'
      );
      expect(authMethod.config.tokenUrl).toBe(
        'https://api.notion.com/v1/oauth/token'
      );
    });

    it('given the provider config, should target Notion API with versioned header', () => {
      expect(notionProvider.baseUrl).toBe('https://api.notion.com/v1');
      expect(notionProvider.defaultHeaders).toEqual({
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      });
    });

    it('given the provider config, should have health check on /users/me', () => {
      expect(notionProvider.healthCheck).toEqual({
        endpoint: '/users/me',
        expectedStatus: 200,
      });
    });

    it('given the provider config, should require accessToken in credential schema', () => {
      const schema = notionProvider.credentialSchema as Record<string, unknown>;
      expect(schema).toBeDefined();
      expect((schema.required as string[])).toContain('accessToken');
    });

    it('given the provider config, should rate limit at 3 req/sec (180/min)', () => {
      expect(notionProvider.rateLimit).toEqual({
        requests: 180,
        windowMs: 60_000,
      });
    });

    it('given the provider config, should have 6 tools', () => {
      expect(notionProvider.tools).toHaveLength(6);
    });
  });

  describe('tool categories', () => {
    it('given read tools, should all be category read', () => {
      const readToolIds = ['search', 'get_page', 'get_database', 'query_database'];
      for (const id of readToolIds) {
        const tool = notionProvider.tools.find((t) => t.id === id)!;
        expect(tool.category, `tool ${id} should be read`).toBe('read');
      }
    });

    it('given write tools, should all be category write', () => {
      const writeToolIds = ['update_page', 'create_page'];
      for (const id of writeToolIds) {
        const tool = notionProvider.tools.find((t) => t.id === id)!;
        expect(tool.category, `tool ${id} should be write`).toBe('write');
      }
    });

    it('given write tools, should have tighter rate limits', () => {
      const writeToolIds = ['update_page', 'create_page'];
      for (const id of writeToolIds) {
        const tool = notionProvider.tools.find((t) => t.id === id)!;
        expect(tool.rateLimit).toEqual({ requests: 10, windowMs: 60_000 });
      }
    });

    it('given read tools, should not have tool-level rate limits', () => {
      const readToolIds = ['search', 'get_page', 'get_database', 'query_database'];
      for (const id of readToolIds) {
        const tool = notionProvider.tools.find((t) => t.id === id)!;
        expect(tool.rateLimit).toBeUndefined();
      }
    });
  });

  describe('search tool', () => {
    const tool = notionProvider.tools.find((t) => t.id === 'search')!;

    it('given the tool, should have no required params', () => {
      expect((tool.inputSchema as { required: string[] }).required).toEqual([]);
    });

    it('given a search query, should build correct POST request with body', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { query: 'meeting notes' };

      const result = buildHttpRequest(config, input, 'https://api.notion.com/v1');

      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://api.notion.com/v1/search');

      const body = JSON.parse(result.body!);
      expect(body.query).toBe('meeting notes');
    });

    it('given filter and sort objects, should pass them through as objects', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const filter = { property: 'object', value: 'page' };
      const sort = { timestamp: 'last_edited_time', direction: 'descending' };
      const input = { query: 'notes', filter, sort };

      const result = buildHttpRequest(config, input, 'https://api.notion.com/v1');
      const body = JSON.parse(result.body!);

      expect(body.filter).toEqual({ property: 'object', value: 'page' });
      expect(body.sort).toEqual({ timestamp: 'last_edited_time', direction: 'descending' });
    });

    it('given no params, should build POST with empty-ish body', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const result = buildHttpRequest(config, {}, 'https://api.notion.com/v1');

      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://api.notion.com/v1/search');
    });

    it('given the tool, should have output transform', () => {
      expect(tool.outputTransform).toBeDefined();
      expect(tool.outputTransform!.extract).toBe('$.results');
      expect(tool.outputTransform!.maxLength).toBe(500);
    });
  });

  describe('get_page tool', () => {
    const tool = notionProvider.tools.find((t) => t.id === 'get_page')!;

    it('given the tool, should require page_id', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toContain('page_id');
    });

    it('given a page_id, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { page_id: 'abc-123-def' };

      const result = buildHttpRequest(config, input, 'https://api.notion.com/v1');

      expect(result.method).toBe('GET');
      expect(result.url).toBe('https://api.notion.com/v1/pages/abc-123-def');
      expect(result.body).toBeUndefined();
    });

    it('given the tool, should have output transform with property mapping', () => {
      expect(tool.outputTransform).toBeDefined();
      expect(tool.outputTransform!.mapping).toHaveProperty('id');
      expect(tool.outputTransform!.mapping).toHaveProperty('url');
      expect(tool.outputTransform!.maxLength).toBe(500);
    });
  });

  describe('update_page tool', () => {
    const tool = notionProvider.tools.find((t) => t.id === 'update_page')!;

    it('given the tool, should require page_id', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toContain('page_id');
      expect(required).not.toContain('properties');
    });

    it('given page_id and properties, should build correct PATCH request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        page_id: 'abc-123',
        properties: { Status: { select: { name: 'Done' } } },
      };

      const result = buildHttpRequest(config, input, 'https://api.notion.com/v1');

      expect(result.method).toBe('PATCH');
      expect(result.url).toBe('https://api.notion.com/v1/pages/abc-123');

      const body = JSON.parse(result.body!);
      expect(body.properties).toEqual({ Status: { select: { name: 'Done' } } });
    });
  });

  describe('get_database tool', () => {
    const tool = notionProvider.tools.find((t) => t.id === 'get_database')!;

    it('given the tool, should require database_id', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toContain('database_id');
    });

    it('given a database_id, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { database_id: 'db-456-xyz' };

      const result = buildHttpRequest(config, input, 'https://api.notion.com/v1');

      expect(result.method).toBe('GET');
      expect(result.url).toBe('https://api.notion.com/v1/databases/db-456-xyz');
      expect(result.body).toBeUndefined();
    });

    it('given the tool, should have output transform', () => {
      expect(tool.outputTransform).toBeDefined();
      expect(tool.outputTransform!.mapping).toHaveProperty('id');
      expect(tool.outputTransform!.mapping).toHaveProperty('title');
      expect(tool.outputTransform!.maxLength).toBe(500);
    });
  });

  describe('query_database tool', () => {
    const tool = notionProvider.tools.find((t) => t.id === 'query_database')!;

    it('given the tool, should require database_id', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toContain('database_id');
    });

    it('given database_id and filter, should build correct POST request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const filter = {
        property: 'Status',
        select: { equals: 'Done' },
      };
      const input = { database_id: 'db-789', filter, page_size: 10 };

      const result = buildHttpRequest(config, input, 'https://api.notion.com/v1');

      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://api.notion.com/v1/databases/db-789/query');

      const body = JSON.parse(result.body!);
      expect(body.filter).toEqual(filter);
    });

    it('given only database_id, should build POST without filter', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { database_id: 'db-789' };

      const result = buildHttpRequest(config, input, 'https://api.notion.com/v1');

      expect(result.url).toBe('https://api.notion.com/v1/databases/db-789/query');
    });

    it('given the tool, should have output transform extracting results', () => {
      expect(tool.outputTransform).toBeDefined();
      expect(tool.outputTransform!.extract).toBe('$.results');
      expect(tool.outputTransform!.maxLength).toBe(500);
    });
  });

  describe('create_page tool', () => {
    const tool = notionProvider.tools.find((t) => t.id === 'create_page')!;

    it('given the tool, should require parent and properties', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toContain('parent');
      expect(required).toContain('properties');
    });

    it('given parent and properties, should build correct POST request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        parent: { database_id: 'db-123' },
        properties: {
          Name: { title: [{ text: { content: 'New page' } }] },
        },
      };

      const result = buildHttpRequest(config, input, 'https://api.notion.com/v1');

      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://api.notion.com/v1/pages');

      const body = JSON.parse(result.body!);
      expect(body.parent).toEqual({ database_id: 'db-123' });
      expect(body.properties.Name.title[0].text.content).toBe('New page');
    });

    it('given parent, properties, and children, should include children in body', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        parent: { page_id: 'page-abc' },
        properties: {
          title: { title: [{ text: { content: 'Sub-page' } }] },
        },
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: [{ text: { content: 'Hello' } }] },
          },
        ],
      };

      const result = buildHttpRequest(config, input, 'https://api.notion.com/v1');

      const body = JSON.parse(result.body!);
      expect(body.children).toHaveLength(1);
      expect(body.children[0].type).toBe('paragraph');
    });

    it('given icon and cover, should include them in the body', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        parent: { database_id: 'db-123' },
        properties: {
          Name: { title: [{ text: { content: 'Styled page' } }] },
        },
        icon: { type: 'emoji', emoji: '🚀' },
        cover: { type: 'external', external: { url: 'https://example.com/img.png' } },
      };

      const result = buildHttpRequest(config, input, 'https://api.notion.com/v1');
      const body = JSON.parse(result.body!);

      expect(body.icon).toEqual({ type: 'emoji', emoji: '🚀' });
      expect(body.cover).toEqual({ type: 'external', external: { url: 'https://example.com/img.png' } });
    });

    it('given the tool, should have output transform', () => {
      expect(tool.outputTransform).toBeDefined();
      expect(tool.outputTransform!.mapping).toHaveProperty('id');
      expect(tool.outputTransform!.mapping).toHaveProperty('url');
      expect(tool.outputTransform!.maxLength).toBe(500);
    });
  });

  describe('update_page archive', () => {
    const tool = notionProvider.tools.find((t) => t.id === 'update_page')!;

    it('given archived flag, should include it in the PATCH body without requiring properties', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        page_id: 'page-to-archive',
        archived: true,
      };

      const result = buildHttpRequest(config, input, 'https://api.notion.com/v1');
      const body = JSON.parse(result.body!);

      expect(body.archived).toBe(true);
      expect(body).not.toHaveProperty('properties');
    });
  });

  describe('schema compatibility', () => {
    it('given all tool input schemas, should convert to valid Zod schemas', () => {
      for (const tool of notionProvider.tools) {
        const zodSchema = convertToolSchemaToZod(tool.inputSchema);
        expect(zodSchema).toBeDefined();
        expect(zodSchema.parse).toBeTypeOf('function');
      }
    });
  });
});
