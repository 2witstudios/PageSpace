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

    it('given the provider config, should use OAuth2 auth with repo, workflow, and read:user scopes', () => {
      const { authMethod } = githubProvider;
      expect(authMethod.type).toBe('oauth2');
      if (authMethod.type !== 'oauth2') throw new Error('unexpected auth type');
      expect(authMethod.config.scopes).toContain('repo');
      expect(authMethod.config.scopes).toContain('workflow');
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

    it('given the provider config, should have 31 tools', () => {
      expect(githubProvider.tools).toHaveLength(31);
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
      'list_commits',
      'compare_refs',
      'list_check_runs',
      'list_workflow_runs',
      'search_issues',
      'list_labels',
      'list_issues',
      'list_issue_comments',
      'get_pull_request',
      'list_pull_requests',
      'list_pr_files',
      'list_pr_reviews',
      'list_pr_review_comments',
    ];

    const writeToolIds = [
      'create_issue',
      'update_issue',
      'create_issue_comment',
      'create_pr_review',
      'create_pr_review_comment',
      'create_branch',
      'create_or_update_file',
      'delete_file',
      'create_pull_request',
      'update_pull_request',
      'merge_pull_request',
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
      const searchToolIds = ['search_code', 'search_issues'];
      const standardReadIds = readToolIds.filter((id) => !searchToolIds.includes(id));
      for (const id of standardReadIds) {
        const tool = findTool(id);
        expect(tool.rateLimit).toBeUndefined();
      }
    });

    it('given search tools, should have stricter rate limits due to GitHub search limits', () => {
      for (const id of ['search_code', 'search_issues']) {
        const tool = findTool(id);
        expect(tool.rateLimit).toEqual({ requests: 10, windowMs: 60_000 });
      }
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

  describe('list_issues tool', () => {
    const tool = findTool('list_issues');

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

    it('given the tool, should require owner and repo (path is optional for root listing)', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo']);
    });

    it('given a nested file path, should build correct GET request with slashes in path', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', path: 'src/utils/helpers.ts' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toBe(
        'https://api.github.com/repos/acme/webapp/contents/src/utils/helpers.ts'
      );
    });

    it('given no path, should build request for repository root', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toContain('/repos/acme/webapp/contents');
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

    it('given a path containing "../" segments, should throw rather than escape the declared repo', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        path: '../../other-org/other-repo/contents/secret.txt',
      };

      expect(() => buildHttpRequest(config, input, 'https://api.github.com')).toThrow();
    });

    it('given the tool config, should declare rawPathParams: ["path"]', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      expect(config.rawPathParams).toEqual(['path']);
    });
  });

  describe('get_repo_tree tool', () => {
    const tool = findTool('get_repo_tree');

    it('given the tool, should require owner, repo, and tree_sha', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'tree_sha']);
    });

    it('given a branch name as tree_sha, should build correct request with recursive=1', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', tree_sha: 'main' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toContain('/repos/acme/webapp/git/trees/main');
      expect(result.url).toContain('recursive=1');
    });

    it('given the tool, should include truncated flag and tree in output mapping', () => {
      expect(tool.outputTransform!.mapping).toHaveProperty('tree');
      expect(tool.outputTransform!.mapping).toHaveProperty('truncated');
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

  describe('list_pr_files tool', () => {
    const tool = findTool('list_pr_files');

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

  describe('list_pr_reviews tool', () => {
    const tool = findTool('list_pr_reviews');

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

  describe('list_pr_review_comments tool', () => {
    const tool = findTool('list_pr_review_comments');

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

    it('given the tool, should require owner, repo, pull_number, event, and body', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number', 'event', 'body']);
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

    it('given the tool, should require owner, repo, pull_number, and body', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number', 'body']);
    });

    it('given a single-line comment, should build correct POST', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        pull_number: 7,
        body: 'Consider using `const` here',
        path: 'src/index.ts',
        commit_id: 'abc123def456',
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

  // ─── New Tool Tests: Commits & CI Reads ────────────────────────────────

  describe('list_commits tool', () => {
    const tool = findTool('list_commits');

    it('given the tool, should require owner and repo', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo']);
    });

    it('given branch and path filters, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', sha: 'develop', path: 'src/index.ts', per_page: 5 };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toContain('/repos/acme/webapp/commits');
      expect(result.url).toContain('sha=develop');
      expect(result.url).toContain('per_page=5');
    });
  });

  describe('compare_refs tool', () => {
    const tool = findTool('compare_refs');

    it('given the tool, should require owner, repo, base, and head', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'base', 'head']);
    });

    it('given base and head, should build a three-dot compare path', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', base: 'main', head: 'feature-x' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/compare/main...feature-x');
    });

    it('given the tool, should map ahead/behind counts', () => {
      expect(tool.outputTransform!.mapping).toHaveProperty('ahead_by');
      expect(tool.outputTransform!.mapping).toHaveProperty('behind_by');
      expect(tool.outputTransform!.mapping).toHaveProperty('total_commits');
    });
  });

  describe('list_check_runs tool', () => {
    const tool = findTool('list_check_runs');

    it('given the tool, should require owner, repo, and ref', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'ref']);
    });

    it('given a commit ref, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', ref: 'abc123' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/commits/abc123/check-runs');
    });

    it('given the tool, should extract check_runs array from response', () => {
      expect(tool.outputTransform!.extract).toBe('$.check_runs');
      expect(tool.outputTransform!.mapping).toHaveProperty('conclusion');
    });
  });

  describe('list_workflow_runs tool', () => {
    const tool = findTool('list_workflow_runs');

    it('given the tool, should require owner and repo', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo']);
    });

    it('given branch and status filters, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', branch: 'main', status: 'failure' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toContain('/repos/acme/webapp/actions/runs');
      expect(result.url).toContain('branch=main');
      expect(result.url).toContain('status=failure');
    });

    it('given the tool, should extract workflow_runs array from response', () => {
      expect(tool.outputTransform!.extract).toBe('$.workflow_runs');
    });
  });

  describe('search_issues tool', () => {
    const tool = findTool('search_issues');

    it('given the tool, should require q parameter', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['q']);
    });

    it('given a search query, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { q: 'login bug repo:acme/webapp is:issue', per_page: 10 };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toContain('/search/issues');
      expect(result.url).toContain('q=login');
      expect(result.url).toContain('per_page=10');
    });

    it('given the tool, should extract items array from response', () => {
      expect(tool.outputTransform!.extract).toBe('$.items');
    });
  });

  describe('list_labels tool', () => {
    const tool = findTool('list_labels');

    it('given the tool, should require owner and repo', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo']);
    });

    it('given owner and repo, should build correct GET request', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/labels');
    });
  });

  // ─── New Tool Tests: Code Contribution Writes ──────────────────────────

  describe('create_branch tool', () => {
    const tool = findTool('create_branch');

    it('given the tool, should require owner, repo, ref, and sha', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'ref', 'sha']);
    });

    it('given a fully qualified ref and sha, should build correct POST', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', ref: 'refs/heads/my-feature', sha: 'abc123' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/git/refs');
      expect(JSON.parse(result.body!)).toEqual({ ref: 'refs/heads/my-feature', sha: 'abc123' });
    });
  });

  describe('create_or_update_file tool', () => {
    const tool = findTool('create_or_update_file');

    it('given the tool, should require owner, repo, path, message, and content', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'path', 'message', 'content']);
    });

    it('given a new file on a branch, should build correct PUT without sha', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        path: 'docs/notes.md',
        message: 'docs: add notes',
        content: 'aGVsbG8=',
        branch: 'my-feature',
      };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.method).toBe('PUT');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/contents/docs/notes.md');

      const body = JSON.parse(result.body!);
      expect(body.message).toBe('docs: add notes');
      expect(body.content).toBe('aGVsbG8=');
      expect(body.branch).toBe('my-feature');
      expect(body).not.toHaveProperty('sha');
    });

    it('given an existing file update, should include the blob sha', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        path: 'README.md',
        message: 'docs: update readme',
        content: 'aGVsbG8=',
        sha: 'blob123',
      };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(JSON.parse(result.body!).sha).toBe('blob123');
    });

    it('given a path containing "../" segments, should throw rather than write to a different repo', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        path: '../../other-org/other-repo/contents/secret.txt',
        message: 'evil commit',
        content: 'aGVsbG8=',
      };

      expect(() => buildHttpRequest(config, input, 'https://api.github.com')).toThrow();
    });

    it('given the tool config, should declare rawPathParams: ["path"]', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      expect(config.rawPathParams).toEqual(['path']);
    });
  });

  describe('delete_file tool', () => {
    const tool = findTool('delete_file');

    it('given the tool, should require owner, repo, path, message, and sha', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'path', 'message', 'sha']);
    });

    it('given a file and its blob sha, should build correct DELETE with body', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        path: 'old/legacy.ts',
        message: 'chore: remove legacy module',
        sha: 'blob123',
        branch: 'cleanup',
      };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.method).toBe('DELETE');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/contents/old/legacy.ts');

      const body = JSON.parse(result.body!);
      expect(body.message).toBe('chore: remove legacy module');
      expect(body.sha).toBe('blob123');
      expect(body.branch).toBe('cleanup');
    });

    it('given a path containing "../" segments, should throw rather than delete from a different repo', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        path: '../../other-org/other-repo/contents/secret.txt',
        message: 'evil delete',
        sha: 'blob123',
      };

      expect(() => buildHttpRequest(config, input, 'https://api.github.com')).toThrow();
    });

    it('given the tool config, should declare rawPathParams: ["path"]', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      expect(config.rawPathParams).toEqual(['path']);
    });
  });

  describe('create_pull_request tool', () => {
    const tool = findTool('create_pull_request');

    it('given the tool, should require owner, repo, title, head, and base', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'title', 'head', 'base']);
    });

    it('given head and base branches, should build correct POST', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        title: 'Add login flow',
        head: 'my-feature',
        base: 'main',
        body: 'Implements the login flow.',
        draft: true,
      };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/pulls');

      const body = JSON.parse(result.body!);
      expect(body.title).toBe('Add login flow');
      expect(body.head).toBe('my-feature');
      expect(body.base).toBe('main');
      expect(body.draft).toBe(true);
    });
  });

  describe('update_pull_request tool', () => {
    const tool = findTool('update_pull_request');

    it('given the tool, should require owner, repo, and pull_number', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number']);
    });

    it('given a new title and body, should build correct PATCH', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = {
        owner: 'acme',
        repo: 'webapp',
        pull_number: 7,
        title: 'Add login flow (with tests)',
        body: 'Updated description.',
      };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.method).toBe('PATCH');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/pulls/7');

      const body = JSON.parse(result.body!);
      expect(body.title).toBe('Add login flow (with tests)');
      expect(body.body).toBe('Updated description.');
      expect(body).not.toHaveProperty('state');
    });
  });

  describe('merge_pull_request tool', () => {
    const tool = findTool('merge_pull_request');

    it('given the tool, should require owner, repo, pull_number, and merge_method', () => {
      const required = (tool.inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number', 'merge_method']);
    });

    it('given a squash merge, should build correct PUT', () => {
      const config = (tool.execution as { config: HttpExecutionConfig }).config;
      const input = { owner: 'acme', repo: 'webapp', pull_number: 7, merge_method: 'squash' };

      const result = buildHttpRequest(config, input, 'https://api.github.com');

      expect(result.method).toBe('PUT');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/pulls/7/merge');
      expect(JSON.parse(result.body!)).toEqual({ merge_method: 'squash' });
    });
  });

  // ─── Tool Bundles ──────────────────────────────────────────────────────

  describe('tool bundles', () => {
    const bundles = githubProvider.toolBundles!;
    const toolIds = new Set(githubProvider.tools.map((t) => t.id));

    it('given the provider, should define read_only, code_review, issue_triage, contributor, and full bundles', () => {
      expect(bundles).toBeDefined();
      const ids = bundles.map((b) => b.id);
      expect(ids).toEqual(['read_only', 'code_review', 'issue_triage', 'contributor', 'full']);
    });

    it('given every bundle, should reference only tool ids that exist on the provider', () => {
      for (const bundle of bundles) {
        for (const id of bundle.toolIds) {
          expect(toolIds.has(id), `bundle ${bundle.id} references unknown tool ${id}`).toBe(true);
        }
      }
    });

    it('given the bundles, should mark exactly one as recommended', () => {
      const recommended = bundles.filter((b) => b.recommended);
      expect(recommended).toHaveLength(1);
      expect(recommended[0].id).toBe('read_only');
    });

    it('given the read_only bundle, should contain only read-category tools', () => {
      const readOnly = bundles.find((b) => b.id === 'read_only')!;
      for (const id of readOnly.toolIds) {
        expect(findTool(id).category).toBe('read');
      }
    });

    it('given the read_only bundle, should contain every read-category tool', () => {
      const readOnly = bundles.find((b) => b.id === 'read_only')!;
      const allReadIds = githubProvider.tools.filter((t) => t.category === 'read').map((t) => t.id);
      expect(new Set(readOnly.toolIds)).toEqual(new Set(allReadIds));
    });

    it('given the full bundle, should contain every tool', () => {
      const full = bundles.find((b) => b.id === 'full')!;
      expect(new Set(full.toolIds)).toEqual(toolIds);
    });

    it('given bundle toolIds, should have no duplicates', () => {
      for (const bundle of bundles) {
        expect(new Set(bundle.toolIds).size, `bundle ${bundle.id} has duplicate tool ids`).toBe(
          bundle.toolIds.length
        );
      }
    });
  });

  describe('connect metadata', () => {
    it('given the provider, should describe every requested OAuth scope in plain English', () => {
      const { authMethod } = githubProvider;
      if (authMethod.type !== 'oauth2') throw new Error('unexpected auth type');
      const descriptions = githubProvider.oauthScopeDescriptions!;
      expect(descriptions).toBeDefined();
      for (const scope of authMethod.config.scopes) {
        expect(descriptions[scope], `missing description for scope ${scope}`).toBeTruthy();
      }
    });

    it('given the provider, should include an identity note for the connect dialog', () => {
      expect(githubProvider.connectNotes).toBeTruthy();
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
