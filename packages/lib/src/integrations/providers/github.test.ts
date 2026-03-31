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

const findTool = (id: string) => githubProvider.tools.find((t) => t.id === id)!;

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

    it('given the provider config, should have 19 tools', () => {
      expect(githubProvider.tools).toHaveLength(19);
    });
  });

  describe('tool categories', () => {
    const readToolIds = [
      'list_repos',
      'get_repo',
      'get_repo_content',
      'get_repo_tree',
      'list_branches',
      'search_code',
      'get_commit',
      'get_issues',
      'list_issue_comments',
      'get_pull_request',
      'list_pull_requests',
      'get_pr_diff',
      'get_pr_reviews',
      'get_pr_review_comments',
    ];

    const writeToolIds = [
      'create_issue',
      'update_issue',
      'create_issue_comment',
      'create_pr_review',
      'create_pr_review_comment',
    ];

    it('given read tools, should all be category read', () => {
      for (const id of readToolIds) {
        const tool = findTool(id);
        expect(tool, `tool ${id} not found`).toBeDefined();
        expect(tool.category).toBe('read');
      }
    });

    it('given write tools, should all be category write', () => {
      for (const id of writeToolIds) {
        const tool = findTool(id);
        expect(tool, `tool ${id} not found`).toBeDefined();
        expect(tool.category).toBe('write');
      }
    });

    it('given write tools, should have tighter rate limits (10/min)', () => {
      for (const id of writeToolIds) {
        const tool = findTool(id);
        expect(tool.rateLimit).toEqual({ requests: 10, windowMs: 60_000 });
      }
    });

    it('given standard read tools, should not have tool-level rate limits', () => {
      const standardReadIds = readToolIds.filter((id) => id !== 'search_code');
      for (const id of standardReadIds) {
        const tool = findTool(id);
        expect(tool.rateLimit).toBeUndefined();
      }
    });

    it('given search_code tool, should have stricter rate limit due to GitHub search limits', () => {
      const tool = findTool('search_code');
      expect(tool.rateLimit).toEqual({ requests: 10, windowMs: 60_000 });
    });

    it('given all tool IDs, should account for every tool in the provider', () => {
      const allIds = [...readToolIds, ...writeToolIds];
      expect(allIds).toHaveLength(githubProvider.tools.length);
      for (const tool of githubProvider.tools) {
        expect(allIds).toContain(tool.id);
      }
    });
  });

  // ─── Existing Tool Tests ───────────────────────────────────────────────

  describe('list_repos tool', () => {
    const tool = findTool('list_repos');

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
    const tool = findTool('get_issues');

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
    const tool = findTool('create_issue');

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

  describe('create_issue_comment tool', () => {
    const tool = findTool('create_issue_comment');

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
    const tool = findTool('get_pull_request');

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

    it('given the tool, should include PR body and stats in output mapping', () => {
      expect(tool.outputTransform!.mapping).toHaveProperty('body');
      expect(tool.outputTransform!.mapping).toHaveProperty('head_sha');
      expect(tool.outputTransform!.mapping).toHaveProperty('additions');
      expect(tool.outputTransform!.mapping).toHaveProperty('deletions');
      expect(tool.outputTransform!.mapping).toHaveProperty('changed_files');
    });
  });

  describe('list_pull_requests tool', () => {
    const tool = findTool('list_pull_requests');

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

  // ─── New Tool Tests: Code Browsing ─────────────────────────────────────

  describe('get_repo tool', () => {
    const tool = findTool('get_repo');

    it('given the tool, should require owner and repo', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo']);
    });

    it('given owner and repo, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.method).toBe('GET');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp');
      expect(result.body).toBeUndefined();
    });

    it('given the tool, should include default_branch and stats in output mapping', () => {
      expect(tool.outputTransform!.mapping).toHaveProperty('default_branch');
      expect(tool.outputTransform!.mapping).toHaveProperty('stargazers_count');
      expect(tool.outputTransform!.mapping).toHaveProperty('topics');
    });
  });

  describe('get_repo_content tool', () => {
    const tool = findTool('get_repo_content');

    it('given the tool, should require owner, repo, and path', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'path']);
    });

    it('given a nested file path, should build correct GET request with slashes in path', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', path: 'src/utils/helpers.ts' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toBe(
        'https://api.github.com/repos/acme/webapp/contents/src/utils/helpers.ts'
      );
    });

    it('given a ref parameter, should include it as query param', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', path: 'README.md', ref: 'develop' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toContain('ref=develop');
    });

    it('given the tool, should have high maxLength for file content (200000)', () => {
      expect(tool.outputTransform!.maxLength).toBe(200000);
    });

    it('given the tool, should include content and encoding in output mapping', () => {
      expect(tool.outputTransform!.mapping).toHaveProperty('content');
      expect(tool.outputTransform!.mapping).toHaveProperty('encoding');
      expect(tool.outputTransform!.mapping).toHaveProperty('sha');
    });
  });

  describe('get_repo_tree tool', () => {
    const tool = findTool('get_repo_tree');

    it('given the tool, should require owner, repo, and tree_sha', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'tree_sha']);
    });

    it('given a branch name as tree_sha, should build correct request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', tree_sha: 'main', recursive: '1' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toContain('/repos/acme/webapp/git/trees/main');
      expect(result.url).toContain('recursive=1');
    });

    it('given the tool, should extract tree array from response', () => {
      expect(tool.outputTransform!.extract).toBe('$.tree');
    });
  });

  describe('list_branches tool', () => {
    const tool = findTool('list_branches');

    it('given the tool, should require owner and repo', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo']);
    });

    it('given owner and repo, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/branches');
    });
  });

  describe('search_code tool', () => {
    const tool = findTool('search_code');

    it('given the tool, should require q parameter', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['q']);
    });

    it('given a search query, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { q: 'useState repo:facebook/react', per_page: 10 };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toContain('/search/code');
      expect(result.url).toContain('q=useState');
      expect(result.url).toContain('per_page=10');
    });

    it('given the tool, should extract items array from response', () => {
      expect(tool.outputTransform!.extract).toBe('$.items');
    });
  });

  describe('get_commit tool', () => {
    const tool = findTool('get_commit');

    it('given the tool, should require owner, repo, and ref', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'ref']);
    });

    it('given a commit SHA, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', ref: 'abc123' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/commits/abc123');
    });

    it('given the tool, should include commit message and stats in output mapping', () => {
      expect(tool.outputTransform!.mapping).toHaveProperty('message');
      expect(tool.outputTransform!.mapping).toHaveProperty('stats');
      expect(tool.outputTransform!.mapping).toHaveProperty('files');
    });
  });

  // ─── New Tool Tests: Issue Comments ────────────────────────────────────

  describe('list_issue_comments tool', () => {
    const tool = findTool('list_issue_comments');

    it('given the tool, should require owner, repo, and issue_number', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'issue_number']);
    });

    it('given issue number and since filter, should build correct request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        issue_number: 42,
        since: '2026-01-01T00:00:00Z',
      };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toContain('/repos/acme/webapp/issues/42/comments');
      expect(result.url).toContain('since=');
    });

    it('given the tool, should include body and user in output mapping', () => {
      expect(tool.outputTransform!.mapping).toHaveProperty('body');
      expect(tool.outputTransform!.mapping).toHaveProperty('user');
    });
  });

  // ─── New Tool Tests: PR Review ─────────────────────────────────────────

  describe('get_pr_diff tool', () => {
    const tool = findTool('get_pr_diff');

    it('given the tool, should require owner, repo, and pull_number', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number']);
    });

    it('given PR number, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', pull_number: 99 };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/pulls/99/files');
    });

    it('given the tool, should have higher maxLength for patch diffs (5000)', () => {
      expect(tool.outputTransform!.maxLength).toBe(5000);
    });

    it('given the tool, should include patch and stats in output mapping', () => {
      expect(tool.outputTransform!.mapping).toHaveProperty('patch');
      expect(tool.outputTransform!.mapping).toHaveProperty('filename');
      expect(tool.outputTransform!.mapping).toHaveProperty('status');
      expect(tool.outputTransform!.mapping).toHaveProperty('additions');
      expect(tool.outputTransform!.mapping).toHaveProperty('deletions');
    });
  });

  describe('get_pr_reviews tool', () => {
    const tool = findTool('get_pr_reviews');

    it('given the tool, should require owner, repo, and pull_number', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number']);
    });

    it('given the tool, should include state and body in output mapping', () => {
      expect(tool.outputTransform!.mapping).toHaveProperty('state');
      expect(tool.outputTransform!.mapping).toHaveProperty('body');
      expect(tool.outputTransform!.mapping).toHaveProperty('user');
    });
  });

  describe('get_pr_review_comments tool', () => {
    const tool = findTool('get_pr_review_comments');

    it('given the tool, should require owner, repo, and pull_number', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number']);
    });

    it('given the tool, should include path, line, and body in output mapping', () => {
      expect(tool.outputTransform!.mapping).toHaveProperty('path');
      expect(tool.outputTransform!.mapping).toHaveProperty('line');
      expect(tool.outputTransform!.mapping).toHaveProperty('body');
      expect(tool.outputTransform!.mapping).toHaveProperty('in_reply_to_id');
    });
  });

  // ─── New Tool Tests: Write Operations ──────────────────────────────────

  describe('update_issue tool', () => {
    const tool = findTool('update_issue');

    it('given the tool, should require owner, repo, and issue_number', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'issue_number']);
    });

    it('given the tool, should use PATCH method', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      expect(config.method).toBe('PATCH');
    });

    it('given state and labels, should build correct PATCH request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        issue_number: 42,
        state: 'closed',
        state_reason: 'completed',
        labels: ['resolved'],
      };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.method).toBe('PATCH');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/issues/42');

      const body = JSON.parse(result.body!);
      expect(body.state).toBe('closed');
      expect(body.state_reason).toBe('completed');
      expect(body.labels).toEqual(['resolved']);
    });
  });

  describe('create_pr_review tool', () => {
    const tool = findTool('create_pr_review');

    it('given the tool, should require owner, repo, pull_number, and event', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number', 'event']);
    });

    it('given an approval with no inline comments, should build correct POST', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        pull_number: 7,
        event: 'APPROVE',
        body: 'Looks good!',
      };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/pulls/7/reviews');

      const body = JSON.parse(result.body!);
      expect(body.event).toBe('APPROVE');
      expect(body.body).toBe('Looks good!');
      expect(body).not.toHaveProperty('comments');
    });

    it('given request_changes with inline comments, should include comments array', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        pull_number: 7,
        event: 'REQUEST_CHANGES',
        body: 'A few issues to fix',
        comments: [
          { path: 'src/index.ts', line: 10, side: 'RIGHT', body: 'This needs a null check' },
          { path: 'src/utils.ts', body: 'Missing error handling' },
        ],
      };

      const result = buildHttpRequest(config, input, 'https://api.github.com');
      const body = JSON.parse(result.body!);

      expect(body.comments).toHaveLength(2);
      expect(body.comments[0].path).toBe('src/index.ts');
      expect(body.comments[0].line).toBe(10);
      expect(body.comments[1].path).toBe('src/utils.ts');
    });

    it('given the tool, should have write rate limit', () => {
      expect(tool.rateLimit).toEqual({ requests: 10, windowMs: 60_000 });
    });
  });

  describe('create_pr_review_comment tool', () => {
    const tool = findTool('create_pr_review_comment');

    it('given the tool, should require owner, repo, pull_number, body, and path', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number', 'body', 'path']);
    });

    it('given a single-line comment, should build correct POST', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        pull_number: 7,
        body: 'Consider using `const` here',
        path: 'src/index.ts',
        line: 42,
        side: 'RIGHT',
      };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/pulls/7/comments');

      const body = JSON.parse(result.body!);
      expect(body.body).toBe('Consider using `const` here');
      expect(body.path).toBe('src/index.ts');
      expect(body.line).toBe(42);
      expect(body.side).toBe('RIGHT');
    });

    it('given a multi-line comment, should include start_line and start_side', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        pull_number: 7,
        body: 'This block can be simplified',
        path: 'src/utils.ts',
        line: 20,
        side: 'RIGHT',
        start_line: 15,
        start_side: 'RIGHT',
      };

      const result = buildHttpRequest(config, input, 'https://api.github.com');
      const body = JSON.parse(result.body!);

      expect(body.start_line).toBe(15);
      expect(body.start_side).toBe('RIGHT');
      expect(body.line).toBe(20);
    });

    it('given the tool, should have write rate limit', () => {
      expect(tool.rateLimit).toEqual({ requests: 10, windowMs: 60_000 });
    });
  });

  // ─── Schema Compatibility ──────────────────────────────────────────────

  describe('schema compatibility', () => {
    it('given all tool input schemas, should convert to valid Zod schemas', () => {
      for (const tool of githubProvider.tools) {
        const zodSchema = convertToolSchemaToZod(tool.inputSchema);
        expect(zodSchema, `tool ${tool.id} schema failed conversion`).toBeDefined();
        expect(zodSchema.parse).toBeTypeOf('function');
      }
    });
  });
});
