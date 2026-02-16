/**
 * GitHub Provider Tests
 *
 * Validates the GitHub provider config structure, tool definitions,
 * rate limits, and integration with buildHttpRequest and convertToolSchemaToZod.
 */

import { describe, it, expect } from 'vitest';
import { githubProvider } from './github';
import { buildHttpRequest } from '../execution/build-request';
import { convertToolSchemaToZod } from '../converter/ai-sdk';
import type { HttpExecutionConfig } from '../types';

describe('githubProvider', () => {
  describe('provider structure', () => {
    it('given the provider config, should have correct identity', () => {
      expect(githubProvider.id).toBe('github');
      expect(githubProvider.name).toBe('GitHub');
    });

    it('given the provider config, should use OAuth2 auth with repo and read:user scopes', () => {
      const { authMethod } = githubProvider;
      expect(authMethod.type).toBe('oauth2');
      if (authMethod.type !== 'oauth2') throw new Error('unexpected auth type');
      expect(authMethod.config.scopes).toContain('repo');
      expect(authMethod.config.scopes).toContain('read:user');
      expect(authMethod.config.pkceRequired).toBe(false);
    });

    it('given the provider config, should have correct OAuth2 URLs', () => {
      const { authMethod } = githubProvider;
      if (authMethod.type !== 'oauth2') throw new Error('unexpected auth type');
      expect(authMethod.config.authorizationUrl).toBe('https://github.com/login/oauth/authorize');
      expect(authMethod.config.tokenUrl).toBe('https://github.com/login/oauth/access_token');
    });

    it('given the provider config, should target GitHub API with correct headers', () => {
      expect(githubProvider.baseUrl).toBe('https://api.github.com');
      expect(githubProvider.defaultHeaders).toEqual({
        'Accept': 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      });
    });

    it('given the provider config, should have health check on /user', () => {
      expect(githubProvider.healthCheck).toEqual({
        endpoint: '/user',
        expectedStatus: 200,
      });
    });

    it('given the provider config, should require accessToken in credential schema', () => {
      const schema = githubProvider.credentialSchema as Record<string, unknown>;
      expect(schema).toBeDefined();
      expect((schema.required as string[])).toContain('accessToken');
    });

    it('given the provider config, should rate limit at 30 req/min', () => {
      expect(githubProvider.rateLimit).toEqual({
        requests: 30,
        windowMs: 60_000,
      });
    });

    it('given the provider config, should have 6 tools', () => {
      expect(githubProvider.tools).toHaveLength(6);
    });
  });

  describe('tool categories', () => {
    it('given read tools, should all be category read', () => {
      const readToolIds = ['list_repos', 'get_issues', 'get_pull_request', 'list_pull_requests'];
      for (const id of readToolIds) {
        const tool = githubProvider.tools.find((t) => t.id === id)!;
        expect(tool.category).toBe('read');
      }
    });

    it('given write tools, should all be category write', () => {
      const writeToolIds = ['create_issue', 'create_pr_comment'];
      for (const id of writeToolIds) {
        const tool = githubProvider.tools.find((t) => t.id === id)!;
        expect(tool.category).toBe('write');
      }
    });

    it('given write tools, should have tighter rate limits (10/min)', () => {
      const writeToolIds = ['create_issue', 'create_pr_comment'];
      for (const id of writeToolIds) {
        const tool = githubProvider.tools.find((t) => t.id === id)!;
        expect(tool.rateLimit).toEqual({ requests: 10, windowMs: 60_000 });
      }
    });

    it('given read tools, should not have tool-level rate limits', () => {
      const readToolIds = ['list_repos', 'get_issues', 'get_pull_request', 'list_pull_requests'];
      for (const id of readToolIds) {
        const tool = githubProvider.tools.find((t) => t.id === id)!;
        expect(tool.rateLimit).toBeUndefined();
      }
    });
  });

  describe('list_repos tool', () => {
    const tool = githubProvider.tools.find((t) => t.id === 'list_repos')!;

    it('given no required params, should have empty required array', () => {
      expect((tool.inputSchema as { required: string[] }).required).toEqual([]);
    });

    it('given optional query params, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { type: 'owner', sort: 'updated', per_page: 10 };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.method).toBe('GET');
      expect(result.url).toContain('/user/repos');
      expect(result.url).toContain('type=owner');
      expect(result.url).toContain('sort=updated');
      expect(result.url).toContain('per_page=10');
      expect(result.body).toBeUndefined();
    });

    it('given no params, should build request without query string params', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const result = buildHttpRequest(config, {}, 'https://api.github.com');

      expect(result.url).toBe('https://api.github.com/user/repos');
    });

    it('given the tool, should have output transform with mapping', () => {
      expect(tool.outputTransform).toBeDefined();
      expect(tool.outputTransform!.mapping).toHaveProperty('full_name');
      expect(tool.outputTransform!.mapping).toHaveProperty('html_url');
      expect(tool.outputTransform!.maxLength).toBe(500);
    });
  });

  describe('get_issues tool', () => {
    const tool = githubProvider.tools.find((t) => t.id === 'get_issues')!;

    it('given the tool, should require owner and repo', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toContain('owner');
      expect(required).toContain('repo');
    });

    it('given owner, repo, and state filter, should build correct request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', state: 'open' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toContain('/repos/acme/webapp/issues');
      expect(result.url).toContain('state=open');
    });
  });

  describe('create_issue tool', () => {
    const tool = githubProvider.tools.find((t) => t.id === 'create_issue')!;

    it('given the tool, should require owner, repo, and title', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toContain('owner');
      expect(required).toContain('repo');
      expect(required).toContain('title');
    });

    it('given required and optional params, should build correct POST request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        title: 'Bug: login broken',
        body: 'Steps to reproduce...',
        labels: ['bug', 'urgent'],
      };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/issues');

      const body = JSON.parse(result.body!);
      expect(body.title).toBe('Bug: login broken');
      expect(body.body).toBe('Steps to reproduce...');
      expect(body.labels).toEqual(['bug', 'urgent']);
    });

    it('given only required params, should omit optional body fields', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', title: 'Feature request' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');
      const body = JSON.parse(result.body!);

      expect(body.title).toBe('Feature request');
      // JSON.stringify omits undefined values
      expect(body).not.toHaveProperty('labels');
      expect(body).not.toHaveProperty('assignees');
    });
  });

  describe('create_pr_comment tool', () => {
    const tool = githubProvider.tools.find((t) => t.id === 'create_pr_comment')!;

    it('given the tool, should require owner, repo, issue_number, and body', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'issue_number', 'body']);
    });

    it('given all required params, should build correct POST with integer path param', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        issue_number: 42,
        body: 'LGTM!',
      };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.method).toBe('POST');
      expect(result.url).toBe(
        'https://api.github.com/repos/acme/webapp/issues/42/comments'
      );
      expect(JSON.parse(result.body!)).toEqual({ body: 'LGTM!' });
    });
  });

  describe('get_pull_request tool', () => {
    const tool = githubProvider.tools.find((t) => t.id === 'get_pull_request')!;

    it('given the tool, should require owner, repo, and pull_number', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toContain('owner');
      expect(required).toContain('repo');
      expect(required).toContain('pull_number');
    });

    it('given all required params, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', pull_number: 7 };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/pulls/7');
      expect(result.body).toBeUndefined();
    });
  });

  describe('list_pull_requests tool', () => {
    const tool = githubProvider.tools.find((t) => t.id === 'list_pull_requests')!;

    it('given the tool, should require owner and repo', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toContain('owner');
      expect(required).toContain('repo');
    });

    it('given owner, repo, and filters, should build correct GET with query params', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', state: 'open', direction: 'desc' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toContain('/repos/acme/webapp/pulls');
      expect(result.url).toContain('state=open');
      expect(result.url).toContain('direction=desc');
    });
  });

  describe('schema compatibility', () => {
    it('given all tool input schemas, should convert to valid Zod schemas', () => {
      for (const tool of githubProvider.tools) {
        const zodSchema = convertToolSchemaToZod(tool.inputSchema);
        expect(zodSchema).toBeDefined();
        expect(zodSchema.parse).toBeTypeOf('function');
      }
    });
  });
});
