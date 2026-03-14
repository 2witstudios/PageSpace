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
const getConfig = (id: string) =>
  (findTool(id).execution as { config: HttpExecutionConfig }).config;

describe('githubProvider', () => {
  // ═══════════════════════════════════════════════════════════════════════
  // PROVIDER STRUCTURE
  // ═══════════════════════════════════════════════════════════════════════
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

    it('given the provider config, should have 34 tools', () => {
      expect(githubProvider.tools).toHaveLength(34);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // TOOL CATEGORIES
  // ═══════════════════════════════════════════════════════════════════════
  describe('tool categories', () => {
    const readToolIds = [
      'list_repos', 'get_repo', 'get_file_content', 'get_tree',
      'get_issues', 'get_issue', 'list_issue_comments',
      'get_pull_request', 'list_pull_requests', 'list_pr_files',
      'get_pr_diff', 'list_pr_commits', 'get_pr_reviews', 'list_pr_review_comments',
      'list_commits', 'get_commit', 'compare_commits',
      'list_branches', 'get_branch',
      'search_code', 'search_issues',
      'list_labels', 'list_releases', 'list_check_runs',
    ];

    const writeToolIds = [
      'create_issue', 'update_issue', 'create_pr_comment',
      'create_pull_request', 'create_pr_review', 'create_pr_review_comment',
      'merge_pull_request', 'request_reviewers', 'add_labels', 'remove_label',
    ];

    it('given read tools, should all be category read', () => {
      for (const id of readToolIds) {
        const tool = findTool(id);
        expect(tool, `tool ${id} should exist`).toBeDefined();
        expect(tool.category).toBe('read');
      }
    });

    it('given write tools, should all be category write', () => {
      for (const id of writeToolIds) {
        const tool = findTool(id);
        expect(tool, `tool ${id} should exist`).toBeDefined();
        expect(tool.category).toBe('write');
      }
    });

    it('given all tools, should account for all read and write tools', () => {
      const allIds = [...readToolIds, ...writeToolIds];
      expect(allIds.length).toBe(githubProvider.tools.length);
      for (const tool of githubProvider.tools) {
        expect(allIds).toContain(tool.id);
      }
    });

    it('given write tools, should all have rate limits', () => {
      for (const id of writeToolIds) {
        const tool = findTool(id);
        expect(tool.rateLimit, `${id} should have rate limit`).toBeDefined();
        expect(tool.rateLimit!.windowMs).toBe(60_000);
      }
    });

    it('given merge_pull_request, should have tighter rate limit (5/min)', () => {
      const tool = findTool('merge_pull_request');
      expect(tool.rateLimit).toEqual({ requests: 5, windowMs: 60_000 });
    });

    it('given search tools, should have rate limits (10/min)', () => {
      for (const id of ['search_code', 'search_issues']) {
        const tool = findTool(id);
        expect(tool.rateLimit).toEqual({ requests: 10, windowMs: 60_000 });
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // REPOSITORY TOOLS
  // ═══════════════════════════════════════════════════════════════════════
  describe('list_repos tool', () => {
    it('given no required params, should have empty required array', () => {
      expect((findTool('list_repos').inputSchema as { required: string[] }).required).toEqual([]);
    });

    it('given optional query params, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('list_repos'),
        { type: 'owner', sort: 'updated', per_page: 10 },
        'https://api.github.com'
      );
      expect(result.method).toBe('GET');
      expect(result.url).toContain('/user/repos');
      expect(result.url).toContain('type=owner');
      expect(result.url).toContain('sort=updated');
      expect(result.url).toContain('per_page=10');
      expect(result.body).toBeUndefined();
    });

    it('given no params, should build request without query string params', () => {
      const result = buildHttpRequest(getConfig('list_repos'), {}, 'https://api.github.com');
      expect(result.url).toBe('https://api.github.com/user/repos');
    });

    it('given the tool, should have output transform with mapping', () => {
      const tool = findTool('list_repos');
      expect(tool.outputTransform).toBeDefined();
      expect(tool.outputTransform!.mapping).toHaveProperty('full_name');
      expect(tool.outputTransform!.mapping).toHaveProperty('html_url');
      expect(tool.outputTransform!.maxLength).toBe(500);
    });
  });

  describe('get_repo tool', () => {
    it('given the tool, should require owner and repo', () => {
      const required = (findTool('get_repo').inputSchema as { required: string[] }).required;
      expect(required).toContain('owner');
      expect(required).toContain('repo');
    });

    it('given owner and repo, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('get_repo'),
        { owner: 'acme', repo: 'webapp' },
        'https://api.github.com'
      );
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp');
      expect(result.method).toBe('GET');
      expect(result.body).toBeUndefined();
    });

    it('given the tool, should expose comprehensive repo metadata', () => {
      const mapping = findTool('get_repo').outputTransform!.mapping!;
      expect(mapping).toHaveProperty('default_branch');
      expect(mapping).toHaveProperty('forks_count');
      expect(mapping).toHaveProperty('open_issues_count');
      expect(mapping).toHaveProperty('topics');
      expect(mapping).toHaveProperty('archived');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FILE CONTENT & TREE TOOLS
  // ═══════════════════════════════════════════════════════════════════════
  describe('get_file_content tool', () => {
    it('given the tool, should require owner, repo, and path', () => {
      const required = (findTool('get_file_content').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'path']);
    });

    it('given owner, repo, and path, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('get_file_content'),
        { owner: 'acme', repo: 'webapp', path: 'src/index.ts' },
        'https://api.github.com'
      );
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/contents/src/index.ts');
      expect(result.method).toBe('GET');
    });

    it('given a ref param, should include it as query param', () => {
      const result = buildHttpRequest(
        getConfig('get_file_content'),
        { owner: 'acme', repo: 'webapp', path: 'README.md', ref: 'feature-branch' },
        'https://api.github.com'
      );
      expect(result.url).toContain('ref=feature-branch');
    });

    it('given the tool, should have large maxLength for file content', () => {
      expect(findTool('get_file_content').outputTransform!.maxLength).toBe(10000);
    });

    it('given the tool, should map content and encoding fields', () => {
      const mapping = findTool('get_file_content').outputTransform!.mapping!;
      expect(mapping).toHaveProperty('content');
      expect(mapping).toHaveProperty('encoding');
      expect(mapping).toHaveProperty('sha');
    });
  });

  describe('get_tree tool', () => {
    it('given the tool, should require owner, repo, and tree_sha', () => {
      const required = (findTool('get_tree').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'tree_sha']);
    });

    it('given params, should build correct GET request with tree SHA', () => {
      const result = buildHttpRequest(
        getConfig('get_tree'),
        { owner: 'acme', repo: 'webapp', tree_sha: 'main' },
        'https://api.github.com'
      );
      expect(result.url).toContain('/repos/acme/webapp/git/trees/main');
    });

    it('given recursive param, should include it in query', () => {
      const result = buildHttpRequest(
        getConfig('get_tree'),
        { owner: 'acme', repo: 'webapp', tree_sha: 'main', recursive: '1' },
        'https://api.github.com'
      );
      expect(result.url).toContain('recursive=1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ISSUE TOOLS
  // ═══════════════════════════════════════════════════════════════════════
  describe('get_issues tool', () => {
    it('given the tool, should require owner and repo', () => {
      const required = (findTool('get_issues').inputSchema as { required: string[] }).required;
      expect(required).toContain('owner');
      expect(required).toContain('repo');
    });

    it('given owner, repo, and state filter, should build correct request', () => {
      const result = buildHttpRequest(
        getConfig('get_issues'),
        { owner: 'acme', repo: 'webapp', state: 'open' },
        'https://api.github.com'
      );
      expect(result.url).toContain('/repos/acme/webapp/issues');
      expect(result.url).toContain('state=open');
    });
  });

  describe('get_issue tool', () => {
    it('given the tool, should require owner, repo, and issue_number', () => {
      const required = (findTool('get_issue').inputSchema as { required: string[] }).required;
      expect(required).toContain('owner');
      expect(required).toContain('repo');
      expect(required).toContain('issue_number');
    });

    it('given params, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('get_issue'),
        { owner: 'acme', repo: 'webapp', issue_number: 42 },
        'https://api.github.com'
      );
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/issues/42');
    });

    it('given the tool, should expose body, labels, assignees, milestone', () => {
      const mapping = findTool('get_issue').outputTransform!.mapping!;
      expect(mapping).toHaveProperty('body');
      expect(mapping).toHaveProperty('labels');
      expect(mapping).toHaveProperty('assignees');
      expect(mapping).toHaveProperty('milestone');
      expect(mapping).toHaveProperty('closed_at');
    });
  });

  describe('list_issue_comments tool', () => {
    it('given the tool, should require owner, repo, and issue_number', () => {
      const required = (findTool('list_issue_comments').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'issue_number']);
    });

    it('given params, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('list_issue_comments'),
        { owner: 'acme', repo: 'webapp', issue_number: 5 },
        'https://api.github.com'
      );
      expect(result.url).toContain('/repos/acme/webapp/issues/5/comments');
    });

    it('given pagination params, should include them in query', () => {
      const result = buildHttpRequest(
        getConfig('list_issue_comments'),
        { owner: 'acme', repo: 'webapp', issue_number: 5, per_page: 50, page: 2 },
        'https://api.github.com'
      );
      expect(result.url).toContain('per_page=50');
      expect(result.url).toContain('page=2');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PULL REQUEST TOOLS
  // ═══════════════════════════════════════════════════════════════════════
  describe('get_pull_request tool', () => {
    it('given the tool, should require owner, repo, and pull_number', () => {
      const required = (findTool('get_pull_request').inputSchema as { required: string[] }).required;
      expect(required).toContain('owner');
      expect(required).toContain('repo');
      expect(required).toContain('pull_number');
    });

    it('given all required params, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('get_pull_request'),
        { owner: 'acme', repo: 'webapp', pull_number: 7 },
        'https://api.github.com'
      );
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/pulls/7');
      expect(result.body).toBeUndefined();
    });

    it('given the tool, should expose diff stats and merge info', () => {
      const mapping = findTool('get_pull_request').outputTransform!.mapping!;
      expect(mapping).toHaveProperty('additions');
      expect(mapping).toHaveProperty('deletions');
      expect(mapping).toHaveProperty('changed_files');
      expect(mapping).toHaveProperty('body');
      expect(mapping).toHaveProperty('mergeable_state');
      expect(mapping).toHaveProperty('head_sha');
      expect(mapping).toHaveProperty('base_sha');
    });
  });

  describe('list_pull_requests tool', () => {
    it('given the tool, should require owner and repo', () => {
      const required = (findTool('list_pull_requests').inputSchema as { required: string[] }).required;
      expect(required).toContain('owner');
      expect(required).toContain('repo');
    });

    it('given owner, repo, and filters, should build correct GET with query params', () => {
      const result = buildHttpRequest(
        getConfig('list_pull_requests'),
        { owner: 'acme', repo: 'webapp', state: 'open', direction: 'desc' },
        'https://api.github.com'
      );
      expect(result.url).toContain('/repos/acme/webapp/pulls');
      expect(result.url).toContain('state=open');
      expect(result.url).toContain('direction=desc');
    });

    it('given head and base filters, should include them', () => {
      const result = buildHttpRequest(
        getConfig('list_pull_requests'),
        { owner: 'acme', repo: 'webapp', head: 'user:feature', base: 'main' },
        'https://api.github.com'
      );
      expect(result.url).toContain('head=user%3Afeature');
      expect(result.url).toContain('base=main');
    });
  });

  describe('list_pr_files tool', () => {
    it('given the tool, should require owner, repo, and pull_number', () => {
      const required = (findTool('list_pr_files').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number']);
    });

    it('given params, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('list_pr_files'),
        { owner: 'acme', repo: 'webapp', pull_number: 7 },
        'https://api.github.com'
      );
      expect(result.url).toContain('/repos/acme/webapp/pulls/7/files');
    });

    it('given pagination, should include query params', () => {
      const result = buildHttpRequest(
        getConfig('list_pr_files'),
        { owner: 'acme', repo: 'webapp', pull_number: 7, per_page: 50 },
        'https://api.github.com'
      );
      expect(result.url).toContain('per_page=50');
    });

    it('given the tool, should map patch and status fields', () => {
      const mapping = findTool('list_pr_files').outputTransform!.mapping!;
      expect(mapping).toHaveProperty('filename');
      expect(mapping).toHaveProperty('status');
      expect(mapping).toHaveProperty('patch');
      expect(mapping).toHaveProperty('additions');
      expect(mapping).toHaveProperty('deletions');
      expect(mapping).toHaveProperty('previous_filename');
    });

    it('given the tool, should have large maxLength for diffs', () => {
      expect(findTool('list_pr_files').outputTransform!.maxLength).toBe(10000);
    });
  });

  describe('get_pr_diff tool', () => {
    it('given the tool, should require owner, repo, and pull_number', () => {
      const required = (findTool('get_pr_diff').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number']);
    });

    it('given params, should build GET request to pulls endpoint', () => {
      const result = buildHttpRequest(
        getConfig('get_pr_diff'),
        { owner: 'acme', repo: 'webapp', pull_number: 7 },
        'https://api.github.com'
      );
      expect(result.url).toContain('/repos/acme/webapp/pulls/7');
    });

    it('given the tool, should set Accept header for diff format', () => {
      const config = getConfig('get_pr_diff');
      expect(config.headers).toEqual({
        'Accept': 'application/vnd.github.v3.diff',
      });
    });

    it('given the tool, should have very large maxLength for full diffs', () => {
      expect(findTool('get_pr_diff').outputTransform!.maxLength).toBe(50000);
    });
  });

  describe('list_pr_commits tool', () => {
    it('given the tool, should require owner, repo, and pull_number', () => {
      const required = (findTool('list_pr_commits').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number']);
    });

    it('given params, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('list_pr_commits'),
        { owner: 'acme', repo: 'webapp', pull_number: 7 },
        'https://api.github.com'
      );
      expect(result.url).toContain('/repos/acme/webapp/pulls/7/commits');
    });

    it('given the tool, should map commit message and author', () => {
      const mapping = findTool('list_pr_commits').outputTransform!.mapping!;
      expect(mapping).toHaveProperty('sha');
      expect(mapping).toHaveProperty('message');
      expect(mapping).toHaveProperty('author');
    });
  });

  describe('get_pr_reviews tool', () => {
    it('given the tool, should require owner, repo, and pull_number', () => {
      const required = (findTool('get_pr_reviews').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number']);
    });

    it('given params, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('get_pr_reviews'),
        { owner: 'acme', repo: 'webapp', pull_number: 7 },
        'https://api.github.com'
      );
      expect(result.url).toContain('/repos/acme/webapp/pulls/7/reviews');
    });

    it('given the tool, should map review state and user', () => {
      const mapping = findTool('get_pr_reviews').outputTransform!.mapping!;
      expect(mapping).toHaveProperty('state');
      expect(mapping).toHaveProperty('user');
      expect(mapping).toHaveProperty('body');
      expect(mapping).toHaveProperty('submitted_at');
    });
  });

  describe('list_pr_review_comments tool', () => {
    it('given the tool, should require owner, repo, and pull_number', () => {
      const required = (findTool('list_pr_review_comments').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number']);
    });

    it('given params, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('list_pr_review_comments'),
        { owner: 'acme', repo: 'webapp', pull_number: 7 },
        'https://api.github.com'
      );
      expect(result.url).toContain('/repos/acme/webapp/pulls/7/comments');
    });

    it('given sort and direction, should include query params', () => {
      const result = buildHttpRequest(
        getConfig('list_pr_review_comments'),
        { owner: 'acme', repo: 'webapp', pull_number: 7, sort: 'updated', direction: 'desc' },
        'https://api.github.com'
      );
      expect(result.url).toContain('sort=updated');
      expect(result.url).toContain('direction=desc');
    });

    it('given the tool, should map inline comment fields', () => {
      const mapping = findTool('list_pr_review_comments').outputTransform!.mapping!;
      expect(mapping).toHaveProperty('path');
      expect(mapping).toHaveProperty('line');
      expect(mapping).toHaveProperty('side');
      expect(mapping).toHaveProperty('diff_hunk');
      expect(mapping).toHaveProperty('in_reply_to_id');
      expect(mapping).toHaveProperty('start_line');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // COMMIT & BRANCH TOOLS
  // ═══════════════════════════════════════════════════════════════════════
  describe('list_commits tool', () => {
    it('given the tool, should require owner and repo', () => {
      const required = (findTool('list_commits').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo']);
    });

    it('given owner and repo, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('list_commits'),
        { owner: 'acme', repo: 'webapp' },
        'https://api.github.com'
      );
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/commits');
    });

    it('given sha, path, and author filters, should include them', () => {
      const result = buildHttpRequest(
        getConfig('list_commits'),
        { owner: 'acme', repo: 'webapp', sha: 'develop', path: 'src/', author: 'dev-user' },
        'https://api.github.com'
      );
      expect(result.url).toContain('sha=develop');
      expect(result.url).toContain('path=src%2F');
      expect(result.url).toContain('author=dev-user');
    });

    it('given since and until date filters, should include them', () => {
      const result = buildHttpRequest(
        getConfig('list_commits'),
        { owner: 'acme', repo: 'webapp', since: '2025-01-01T00:00:00Z', until: '2025-12-31T23:59:59Z' },
        'https://api.github.com'
      );
      expect(result.url).toContain('since=');
      expect(result.url).toContain('until=');
    });
  });

  describe('get_commit tool', () => {
    it('given the tool, should require owner, repo, and ref', () => {
      const required = (findTool('get_commit').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'ref']);
    });

    it('given a commit SHA, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('get_commit'),
        { owner: 'acme', repo: 'webapp', ref: 'abc123' },
        'https://api.github.com'
      );
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/commits/abc123');
    });

    it('given the tool, should map stats, files, and parents', () => {
      const mapping = findTool('get_commit').outputTransform!.mapping!;
      expect(mapping).toHaveProperty('stats');
      expect(mapping).toHaveProperty('files');
      expect(mapping).toHaveProperty('parents');
    });
  });

  describe('compare_commits tool', () => {
    it('given the tool, should require owner, repo, and basehead', () => {
      const required = (findTool('compare_commits').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'basehead']);
    });

    it('given a basehead comparison, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('compare_commits'),
        { owner: 'acme', repo: 'webapp', basehead: 'main...feature' },
        'https://api.github.com'
      );
      expect(result.url).toContain('/repos/acme/webapp/compare/main...feature');
    });

    it('given the tool, should map comparison metadata', () => {
      const mapping = findTool('compare_commits').outputTransform!.mapping!;
      expect(mapping).toHaveProperty('status');
      expect(mapping).toHaveProperty('ahead_by');
      expect(mapping).toHaveProperty('behind_by');
      expect(mapping).toHaveProperty('total_commits');
      expect(mapping).toHaveProperty('files');
    });
  });

  describe('list_branches tool', () => {
    it('given the tool, should require owner and repo', () => {
      const required = (findTool('list_branches').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo']);
    });

    it('given owner and repo, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('list_branches'),
        { owner: 'acme', repo: 'webapp' },
        'https://api.github.com'
      );
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/branches');
    });

    it('given protected filter, should include it', () => {
      const result = buildHttpRequest(
        getConfig('list_branches'),
        { owner: 'acme', repo: 'webapp', protected: 'true' },
        'https://api.github.com'
      );
      expect(result.url).toContain('protected=true');
    });
  });

  describe('get_branch tool', () => {
    it('given the tool, should require owner, repo, and branch', () => {
      const required = (findTool('get_branch').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'branch']);
    });

    it('given params, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('get_branch'),
        { owner: 'acme', repo: 'webapp', branch: 'main' },
        'https://api.github.com'
      );
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/branches/main');
    });

    it('given the tool, should map branch details', () => {
      const mapping = findTool('get_branch').outputTransform!.mapping!;
      expect(mapping).toHaveProperty('name');
      expect(mapping).toHaveProperty('protected');
      expect(mapping).toHaveProperty('commit_sha');
      expect(mapping).toHaveProperty('commit_message');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SEARCH TOOLS
  // ═══════════════════════════════════════════════════════════════════════
  describe('search_code tool', () => {
    it('given the tool, should require q param', () => {
      const required = (findTool('search_code').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['q']);
    });

    it('given a query, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('search_code'),
        { q: 'addClass repo:jquery/jquery language:js' },
        'https://api.github.com'
      );
      expect(result.url).toContain('/search/code');
      expect(result.url).toContain('q=');
    });

    it('given sort and order, should include them', () => {
      const result = buildHttpRequest(
        getConfig('search_code'),
        { q: 'test', sort: 'indexed', order: 'desc' },
        'https://api.github.com'
      );
      expect(result.url).toContain('sort=indexed');
      expect(result.url).toContain('order=desc');
    });
  });

  describe('search_issues tool', () => {
    it('given the tool, should require q param', () => {
      const required = (findTool('search_issues').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['q']);
    });

    it('given a query with qualifiers, should build correct request', () => {
      const result = buildHttpRequest(
        getConfig('search_issues'),
        { q: 'bug is:open repo:acme/webapp label:critical' },
        'https://api.github.com'
      );
      expect(result.url).toContain('/search/issues');
      expect(result.url).toContain('q=');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // LABELS, RELEASES, CHECK RUNS
  // ═══════════════════════════════════════════════════════════════════════
  describe('list_labels tool', () => {
    it('given the tool, should require owner and repo', () => {
      const required = (findTool('list_labels').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo']);
    });

    it('given params, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('list_labels'),
        { owner: 'acme', repo: 'webapp' },
        'https://api.github.com'
      );
      expect(result.url).toContain('/repos/acme/webapp/labels');
    });
  });

  describe('list_releases tool', () => {
    it('given the tool, should require owner and repo', () => {
      const required = (findTool('list_releases').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo']);
    });

    it('given params, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('list_releases'),
        { owner: 'acme', repo: 'webapp' },
        'https://api.github.com'
      );
      expect(result.url).toContain('/repos/acme/webapp/releases');
    });

    it('given the tool, should map release metadata', () => {
      const mapping = findTool('list_releases').outputTransform!.mapping!;
      expect(mapping).toHaveProperty('tag_name');
      expect(mapping).toHaveProperty('body');
      expect(mapping).toHaveProperty('prerelease');
    });
  });

  describe('list_check_runs tool', () => {
    it('given the tool, should require owner, repo, and ref', () => {
      const required = (findTool('list_check_runs').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'ref']);
    });

    it('given params, should build correct GET request', () => {
      const result = buildHttpRequest(
        getConfig('list_check_runs'),
        { owner: 'acme', repo: 'webapp', ref: 'main' },
        'https://api.github.com'
      );
      expect(result.url).toContain('/repos/acme/webapp/commits/main/check-runs');
    });

    it('given status filter, should include it', () => {
      const result = buildHttpRequest(
        getConfig('list_check_runs'),
        { owner: 'acme', repo: 'webapp', ref: 'main', status: 'completed' },
        'https://api.github.com'
      );
      expect(result.url).toContain('status=completed');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // WRITE TOOLS - Issues
  // ═══════════════════════════════════════════════════════════════════════
  describe('create_issue tool', () => {
    it('given the tool, should require owner, repo, and title', () => {
      const required = (findTool('create_issue').inputSchema as { required: string[] }).required;
      expect(required).toContain('owner');
      expect(required).toContain('repo');
      expect(required).toContain('title');
    });

    it('given required and optional params, should build correct POST request', () => {
      const result = buildHttpRequest(
        getConfig('create_issue'),
        {
          owner: 'acme',
          repo: 'webapp',
          title: 'Bug: login broken',
          body: 'Steps to reproduce...',
          labels: ['bug', 'urgent'],
        },
        'https://api.github.com'
      );
      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/issues');
      const body = JSON.parse(result.body!);
      expect(body.title).toBe('Bug: login broken');
      expect(body.body).toBe('Steps to reproduce...');
      expect(body.labels).toEqual(['bug', 'urgent']);
    });

    it('given only required params, should omit optional body fields', () => {
      const result = buildHttpRequest(
        getConfig('create_issue'),
        { owner: 'acme', repo: 'webapp', title: 'Feature request' },
        'https://api.github.com'
      );
      const body = JSON.parse(result.body!);
      expect(body.title).toBe('Feature request');
      expect(body).not.toHaveProperty('labels');
      expect(body).not.toHaveProperty('assignees');
    });
  });

  describe('update_issue tool', () => {
    it('given the tool, should require owner, repo, and issue_number', () => {
      const required = (findTool('update_issue').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'issue_number']);
    });

    it('given state change, should build correct PATCH request', () => {
      const result = buildHttpRequest(
        getConfig('update_issue'),
        { owner: 'acme', repo: 'webapp', issue_number: 42, state: 'closed' },
        'https://api.github.com'
      );
      expect(result.method).toBe('PATCH');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/issues/42');
      const body = JSON.parse(result.body!);
      expect(body.state).toBe('closed');
    });

    it('given labels and assignees, should include them in body', () => {
      const result = buildHttpRequest(
        getConfig('update_issue'),
        { owner: 'acme', repo: 'webapp', issue_number: 42, labels: ['wontfix'], assignees: ['dev1'] },
        'https://api.github.com'
      );
      const body = JSON.parse(result.body!);
      expect(body.labels).toEqual(['wontfix']);
      expect(body.assignees).toEqual(['dev1']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // WRITE TOOLS - Pull Requests
  // ═══════════════════════════════════════════════════════════════════════
  describe('create_pr_comment tool', () => {
    it('given the tool, should require owner, repo, issue_number, and body', () => {
      const required = (findTool('create_pr_comment').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'issue_number', 'body']);
    });

    it('given all required params, should build correct POST with integer path param', () => {
      const result = buildHttpRequest(
        getConfig('create_pr_comment'),
        { owner: 'acme', repo: 'webapp', issue_number: 42, body: 'LGTM!' },
        'https://api.github.com'
      );
      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/issues/42/comments');
      expect(JSON.parse(result.body!)).toEqual({ body: 'LGTM!' });
    });
  });

  describe('create_pull_request tool', () => {
    it('given the tool, should require owner, repo, title, head, and base', () => {
      const required = (findTool('create_pull_request').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'title', 'head', 'base']);
    });

    it('given all params, should build correct POST request', () => {
      const result = buildHttpRequest(
        getConfig('create_pull_request'),
        {
          owner: 'acme',
          repo: 'webapp',
          title: 'Add feature X',
          body: 'This PR adds feature X',
          head: 'feature-x',
          base: 'main',
          draft: true,
        },
        'https://api.github.com'
      );
      expect(result.method).toBe('POST');
      expect(result.url).toBe('https://api.github.com/repos/acme/webapp/pulls');
      const body = JSON.parse(result.body!);
      expect(body.title).toBe('Add feature X');
      expect(body.head).toBe('feature-x');
      expect(body.base).toBe('main');
      expect(body.draft).toBe(true);
    });
  });

  describe('create_pr_review tool', () => {
    it('given the tool, should require owner, repo, pull_number, and event', () => {
      const required = (findTool('create_pr_review').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number', 'event']);
    });

    it('given an APPROVE review, should build correct POST request', () => {
      const result = buildHttpRequest(
        getConfig('create_pr_review'),
        {
          owner: 'acme',
          repo: 'webapp',
          pull_number: 7,
          body: 'Looks good!',
          event: 'APPROVE',
        },
        'https://api.github.com'
      );
      expect(result.method).toBe('POST');
      expect(result.url).toContain('/repos/acme/webapp/pulls/7/reviews');
      const body = JSON.parse(result.body!);
      expect(body.event).toBe('APPROVE');
      expect(body.body).toBe('Looks good!');
    });

    it('given REQUEST_CHANGES with inline comments, should include comments array', () => {
      const result = buildHttpRequest(
        getConfig('create_pr_review'),
        {
          owner: 'acme',
          repo: 'webapp',
          pull_number: 7,
          event: 'REQUEST_CHANGES',
          body: 'Please fix these issues',
          comments: [
            { path: 'src/index.ts', line: 10, body: 'This needs a null check' },
            { path: 'src/utils.ts', line: 25, side: 'RIGHT', body: 'Missing return type' },
          ],
        },
        'https://api.github.com'
      );
      const body = JSON.parse(result.body!);
      expect(body.event).toBe('REQUEST_CHANGES');
      expect(body.comments).toHaveLength(2);
      expect(body.comments[0].path).toBe('src/index.ts');
      expect(body.comments[0].line).toBe(10);
    });
  });

  describe('create_pr_review_comment tool', () => {
    it('given the tool, should require owner, repo, pull_number, body, and path', () => {
      const required = (findTool('create_pr_review_comment').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number', 'body', 'path']);
    });

    it('given inline comment params, should build correct POST request', () => {
      const result = buildHttpRequest(
        getConfig('create_pr_review_comment'),
        {
          owner: 'acme',
          repo: 'webapp',
          pull_number: 7,
          body: 'This needs refactoring',
          path: 'src/utils.ts',
          line: 42,
          side: 'RIGHT',
        },
        'https://api.github.com'
      );
      expect(result.method).toBe('POST');
      expect(result.url).toContain('/repos/acme/webapp/pulls/7/comments');
      const body = JSON.parse(result.body!);
      expect(body.body).toBe('This needs refactoring');
      expect(body.path).toBe('src/utils.ts');
      expect(body.line).toBe(42);
      expect(body.side).toBe('RIGHT');
    });

    it('given multi-line range, should include start_line and start_side', () => {
      const result = buildHttpRequest(
        getConfig('create_pr_review_comment'),
        {
          owner: 'acme',
          repo: 'webapp',
          pull_number: 7,
          body: 'This block needs work',
          path: 'src/index.ts',
          line: 20,
          start_line: 15,
          side: 'RIGHT',
          start_side: 'RIGHT',
        },
        'https://api.github.com'
      );
      const body = JSON.parse(result.body!);
      expect(body.start_line).toBe(15);
      expect(body.start_side).toBe('RIGHT');
    });

    it('given in_reply_to, should include it in body', () => {
      const result = buildHttpRequest(
        getConfig('create_pr_review_comment'),
        {
          owner: 'acme',
          repo: 'webapp',
          pull_number: 7,
          body: 'Good point, fixed!',
          path: 'src/index.ts',
          in_reply_to: 12345,
        },
        'https://api.github.com'
      );
      const body = JSON.parse(result.body!);
      expect(body.in_reply_to).toBe(12345);
    });
  });

  describe('merge_pull_request tool', () => {
    it('given the tool, should require owner, repo, and pull_number', () => {
      const required = (findTool('merge_pull_request').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number']);
    });

    it('given merge params, should build correct PUT request', () => {
      const result = buildHttpRequest(
        getConfig('merge_pull_request'),
        {
          owner: 'acme',
          repo: 'webapp',
          pull_number: 7,
          merge_method: 'squash',
          commit_title: 'feat: add feature X (#7)',
        },
        'https://api.github.com'
      );
      expect(result.method).toBe('PUT');
      expect(result.url).toContain('/repos/acme/webapp/pulls/7/merge');
      const body = JSON.parse(result.body!);
      expect(body.merge_method).toBe('squash');
      expect(body.commit_title).toBe('feat: add feature X (#7)');
    });

    it('given SHA guard, should include it for safe merging', () => {
      const result = buildHttpRequest(
        getConfig('merge_pull_request'),
        { owner: 'acme', repo: 'webapp', pull_number: 7, sha: 'abc123' },
        'https://api.github.com'
      );
      const body = JSON.parse(result.body!);
      expect(body.sha).toBe('abc123');
    });
  });

  describe('request_reviewers tool', () => {
    it('given the tool, should require owner, repo, and pull_number', () => {
      const required = (findTool('request_reviewers').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'pull_number']);
    });

    it('given reviewer usernames and teams, should build correct POST request', () => {
      const result = buildHttpRequest(
        getConfig('request_reviewers'),
        {
          owner: 'acme',
          repo: 'webapp',
          pull_number: 7,
          reviewers: ['alice', 'bob'],
          team_reviewers: ['frontend-team'],
        },
        'https://api.github.com'
      );
      expect(result.method).toBe('POST');
      expect(result.url).toContain('/repos/acme/webapp/pulls/7/requested_reviewers');
      const body = JSON.parse(result.body!);
      expect(body.reviewers).toEqual(['alice', 'bob']);
      expect(body.team_reviewers).toEqual(['frontend-team']);
    });
  });

  describe('add_labels tool', () => {
    it('given the tool, should require owner, repo, issue_number, and labels', () => {
      const required = (findTool('add_labels').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'issue_number', 'labels']);
    });

    it('given labels array, should build correct POST request', () => {
      const result = buildHttpRequest(
        getConfig('add_labels'),
        { owner: 'acme', repo: 'webapp', issue_number: 42, labels: ['bug', 'priority:high'] },
        'https://api.github.com'
      );
      expect(result.method).toBe('POST');
      expect(result.url).toContain('/repos/acme/webapp/issues/42/labels');
      const body = JSON.parse(result.body!);
      expect(body.labels).toEqual(['bug', 'priority:high']);
    });
  });

  describe('remove_label tool', () => {
    it('given the tool, should require owner, repo, issue_number, and name', () => {
      const required = (findTool('remove_label').inputSchema as { required: string[] }).required;
      expect(required).toEqual(['owner', 'repo', 'issue_number', 'name']);
    });

    it('given params, should build correct DELETE request with label in path', () => {
      const result = buildHttpRequest(
        getConfig('remove_label'),
        { owner: 'acme', repo: 'webapp', issue_number: 42, name: 'wontfix' },
        'https://api.github.com'
      );
      expect(result.method).toBe('DELETE');
      expect(result.url).toContain('/repos/acme/webapp/issues/42/labels/wontfix');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SCHEMA COMPATIBILITY
  // ═══════════════════════════════════════════════════════════════════════
  describe('schema compatibility', () => {
    it('given all tool input schemas, should convert to valid Zod schemas', () => {
      for (const tool of githubProvider.tools) {
        const zodSchema = convertToolSchemaToZod(tool.inputSchema);
        expect(zodSchema, `${tool.id} schema should convert`).toBeDefined();
        expect(zodSchema.parse).toBeTypeOf('function');
      }
    });

    it('given all tools, should have unique IDs', () => {
      const ids = githubProvider.tools.map((t) => t.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('given all tools, should have outputTransform defined', () => {
      for (const tool of githubProvider.tools) {
        expect(tool.outputTransform, `${tool.id} should have outputTransform`).toBeDefined();
      }
    });
  });
});
