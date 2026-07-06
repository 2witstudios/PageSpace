/**
 * GitHub Provider Adapter
 *
 * Provides AI agents with access to GitHub repositories, issues,
 * and pull requests via the GitHub REST API v3.
 */

import type { IntegrationProviderConfig } from '../types';

export const githubProvider: IntegrationProviderConfig = {
  id: 'github',
  name: 'GitHub',
  description:
    'Access GitHub repositories, code, issues, and pull requests. Browse files, review PRs with inline comments, manage issues, and search code.',
  documentationUrl: 'https://docs.github.com/en/rest',
  authMethod: {
    type: 'oauth2',
    config: {
      authorizationUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      revokeUrl: 'https://github.com/settings/connections/applications',
      scopes: ['repo', 'workflow', 'read:user'],
      pkceRequired: false,
    },
  },
  oauthScopeDescriptions: {
    repo: 'Read and write code, issues, and pull requests on any repository your GitHub account can access',
    workflow: 'Update GitHub Actions workflow files when committing code',
    'read:user': 'Read your GitHub profile (username and avatar)',
  },
  connectNotes:
    'Agents you grant this connection act as you on GitHub — anything they do (comments, reviews, issues) appears under your GitHub account. You choose exactly which actions each agent can take after connecting.',
  baseUrl: 'https://api.github.com',
  defaultHeaders: {
    'Accept': 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
  healthCheck: {
    endpoint: '/user',
    expectedStatus: 200,
  },
  credentialSchema: {
    type: 'object',
    properties: {
      accessToken: {
        type: 'string',
        description: 'OAuth2 access token',
      },
      refreshToken: {
        type: 'string',
        description: 'OAuth2 refresh token',
      },
    },
    required: ['accessToken'],
  },
  rateLimit: { requests: 30, windowMs: 60_000 },
  tools: [
    // ─── Read Tools: Repositories ────────────────────────────────────────
    {
      id: 'list_repos',
      name: 'List Repositories',
      description: 'List repositories for the authenticated user',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['all', 'owner', 'public', 'private', 'member'],
            description: 'Type of repositories to list',
          },
          sort: {
            type: 'string',
            enum: ['created', 'updated', 'pushed', 'full_name'],
            description: 'Sort field',
          },
          per_page: {
            type: 'integer',
            description: 'Results per page (max 100)',
          },
          page: {
            type: 'integer',
            description: 'Page number',
          },
        },
        required: [],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/user/repos',
          queryParams: {
            type: { $param: 'type' },
            sort: { $param: 'sort' },
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          full_name: 'full_name',
          html_url: 'html_url',
          description: 'description',
          language: 'language',
          stargazers_count: 'stargazers_count',
          updated_at: 'updated_at',
          private: 'private',
        },
        maxLength: 500,
      },
    },
    {
      id: 'get_repo',
      name: 'Get Repository',
      description:
        'Get detailed information about a repository including stats, default branch, topics, and visibility',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
        },
        required: ['owner', 'repo'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}',
        },
      },
      outputTransform: {
        mapping: {
          full_name: 'full_name',
          description: 'description',
          html_url: 'html_url',
          language: 'language',
          default_branch: 'default_branch',
          visibility: 'visibility',
          private: 'private',
          fork: 'fork',
          stargazers_count: 'stargazers_count',
          forks_count: 'forks_count',
          open_issues_count: 'open_issues_count',
          topics: 'topics',
          created_at: 'created_at',
          updated_at: 'updated_at',
          pushed_at: 'pushed_at',
          owner_login: 'owner.login',
          license_name: 'license.name',
        },
        maxLength: 500,
      },
    },

    // ─── Read Tools: Code Browsing ───────────────────────────────────────
    {
      id: 'get_repo_content',
      name: 'Get Repository Content',
      description:
        'Read file content or list directory contents from a repository. For files, returns base64-encoded content in the "content" field. For directories, returns an array of entries with name, path, type, and size. Omit path to list the repository root.',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          path: {
            type: 'string',
            description: 'Path to file or directory (e.g. "src/index.ts" or "docs"). Omit to list repository root.',
          },
          ref: {
            type: 'string',
            description: 'Branch, tag, or commit SHA (defaults to default branch)',
          },
        },
        required: ['owner', 'repo'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/contents/{path}',
          rawPathParams: ['path'],
          queryParams: {
            ref: { $param: 'ref' },
          },
        },
      },
      outputTransform: {
        mapping: {
          name: 'name',
          path: 'path',
          type: 'type',
          size: 'size',
          content: 'content',
          encoding: 'encoding',
          sha: 'sha',
          html_url: 'html_url',
          download_url: 'download_url',
        },
        maxLength: 200000,
      },
    },
    {
      id: 'get_repo_tree',
      name: 'Get Repository Tree',
      description:
        'Get the full recursive file tree of a repository at a given branch or commit SHA. For very large repos (>100k files), the response may be truncated — check the "truncated" field.',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          tree_sha: {
            type: 'string',
            description: 'Tree SHA, branch name, or commit SHA (e.g. "main", "HEAD")',
          },
        },
        required: ['owner', 'repo', 'tree_sha'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/git/trees/{tree_sha}',
          queryParams: {
            recursive: '1',
          },
        },
      },
      outputTransform: {
        mapping: {
          sha: 'sha',
          tree: 'tree',
          truncated: 'truncated',
        },
        maxLength: 500,
      },
    },
    {
      id: 'list_branches',
      name: 'List Branches',
      description: 'List branches for a repository',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          protected: {
            type: 'boolean',
            description: 'Filter to only protected branches',
          },
          per_page: {
            type: 'integer',
            description: 'Results per page (max 100)',
          },
          page: {
            type: 'integer',
            description: 'Page number',
          },
        },
        required: ['owner', 'repo'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/branches',
          queryParams: {
            protected: { $param: 'protected', transform: 'string' },
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          name: 'name',
          protected: 'protected',
          commit_sha: 'commit.sha',
        },
        maxLength: 500,
      },
    },
    {
      id: 'search_code',
      name: 'Search Code',
      description:
        'Search for code in GitHub repositories. Uses GitHub search syntax — always include "repo:owner/repo" in the query to scope to a specific repository. Example: "useState repo:facebook/react language:typescript"',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          q: {
            type: 'string',
            description:
              'Search query using GitHub code search syntax. Include "repo:owner/repo" to scope to a repository.',
          },
          sort: {
            type: 'string',
            enum: ['indexed'],
            description: 'Sort field (only "indexed" is supported)',
          },
          order: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort order',
          },
          per_page: {
            type: 'integer',
            description: 'Results per page (max 100)',
          },
          page: {
            type: 'integer',
            description: 'Page number',
          },
        },
        required: ['q'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/search/code',
          queryParams: {
            q: { $param: 'q' },
            sort: { $param: 'sort' },
            order: { $param: 'order' },
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        extract: '$.items',
        mapping: {
          name: 'name',
          path: 'path',
          sha: 'sha',
          html_url: 'html_url',
          repository: 'repository.full_name',
          score: 'score',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'get_commit',
      name: 'Get Commit',
      description:
        'Get details of a specific commit including message, author, stats, and changed files',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          ref: {
            type: 'string',
            description: 'Commit SHA, branch name, or tag name',
          },
        },
        required: ['owner', 'repo', 'ref'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/commits/{ref}',
        },
      },
      outputTransform: {
        mapping: {
          sha: 'sha',
          message: 'commit.message',
          author_name: 'commit.author.name',
          author_email: 'commit.author.email',
          author_date: 'commit.author.date',
          committer: 'commit.committer.name',
          html_url: 'html_url',
          stats: 'stats',
          files: 'files',
        },
        maxLength: 5000,
      },
    },

    {
      id: 'list_commits',
      name: 'List Commits',
      description:
        'List commits on a repository branch, optionally filtered to a file path',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          sha: {
            type: 'string',
            description: 'Branch name or commit SHA to start listing from (defaults to default branch)',
          },
          path: {
            type: 'string',
            description: 'Only commits containing this file path',
          },
          per_page: {
            type: 'integer',
            description: 'Results per page (max 100)',
          },
          page: {
            type: 'integer',
            description: 'Page number',
          },
        },
        required: ['owner', 'repo'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/commits',
          queryParams: {
            sha: { $param: 'sha' },
            path: { $param: 'path' },
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          sha: 'sha',
          message: 'commit.message',
          author_name: 'commit.author.name',
          author_date: 'commit.author.date',
          html_url: 'html_url',
        },
        maxLength: 500,
      },
    },
    {
      id: 'compare_refs',
      name: 'Compare Refs',
      description:
        'Compare two branches, tags, or commits (like a PR diff preview). Returns ahead/behind counts and total commits between base and head.',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          base: {
            type: 'string',
            description: 'Base ref (branch, tag, or commit SHA)',
          },
          head: {
            type: 'string',
            description: 'Head ref (branch, tag, or commit SHA)',
          },
        },
        required: ['owner', 'repo', 'base', 'head'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/compare/{base}...{head}',
        },
      },
      outputTransform: {
        mapping: {
          status: 'status',
          ahead_by: 'ahead_by',
          behind_by: 'behind_by',
          total_commits: 'total_commits',
          merge_base_sha: 'merge_base_commit.sha',
          html_url: 'html_url',
        },
        maxLength: 500,
      },
    },
    {
      id: 'list_check_runs',
      name: 'List Check Runs',
      description:
        'List CI check runs (build, lint, tests) for a commit SHA, branch, or tag. Use the PR head SHA to see whether a pull request is green.',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          ref: {
            type: 'string',
            description: 'Commit SHA, branch name, or tag name',
          },
          per_page: {
            type: 'integer',
            description: 'Results per page (max 100)',
          },
          page: {
            type: 'integer',
            description: 'Page number',
          },
        },
        required: ['owner', 'repo', 'ref'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/commits/{ref}/check-runs',
          queryParams: {
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        extract: '$.check_runs',
        mapping: {
          name: 'name',
          status: 'status',
          conclusion: 'conclusion',
          html_url: 'html_url',
          started_at: 'started_at',
          completed_at: 'completed_at',
        },
        maxLength: 500,
      },
    },
    {
      id: 'list_workflow_runs',
      name: 'List Workflow Runs',
      description:
        'List GitHub Actions workflow runs for a repository, filterable by branch and status. Use to check CI outcomes after a push.',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          branch: {
            type: 'string',
            description: 'Filter runs to a branch',
          },
          status: {
            type: 'string',
            enum: ['queued', 'in_progress', 'completed', 'success', 'failure'],
            description: 'Filter by run status or conclusion',
          },
          event: {
            type: 'string',
            description: 'Filter by trigger event (e.g. "push", "pull_request")',
          },
          per_page: {
            type: 'integer',
            description: 'Results per page (max 100)',
          },
          page: {
            type: 'integer',
            description: 'Page number',
          },
        },
        required: ['owner', 'repo'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/actions/runs',
          queryParams: {
            branch: { $param: 'branch' },
            status: { $param: 'status' },
            event: { $param: 'event' },
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        extract: '$.workflow_runs',
        mapping: {
          id: 'id',
          name: 'name',
          status: 'status',
          conclusion: 'conclusion',
          head_branch: 'head_branch',
          event: 'event',
          html_url: 'html_url',
          created_at: 'created_at',
        },
        maxLength: 500,
      },
    },
    {
      id: 'search_issues',
      name: 'Search Issues and PRs',
      description:
        'Search issues and pull requests across GitHub. Uses GitHub search syntax — include "repo:owner/repo" to scope to a repository. Example: "login bug repo:acme/webapp is:issue is:open"',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          q: {
            type: 'string',
            description:
              'Search query using GitHub issue search syntax. Include "repo:owner/repo" to scope to a repository and "is:issue" or "is:pr" to filter type.',
          },
          sort: {
            type: 'string',
            enum: ['created', 'updated', 'comments'],
            description: 'Sort field',
          },
          order: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort order',
          },
          per_page: {
            type: 'integer',
            description: 'Results per page (max 100)',
          },
          page: {
            type: 'integer',
            description: 'Page number',
          },
        },
        required: ['q'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/search/issues',
          queryParams: {
            q: { $param: 'q' },
            sort: { $param: 'sort' },
            order: { $param: 'order' },
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        extract: '$.items',
        mapping: {
          number: 'number',
          title: 'title',
          state: 'state',
          html_url: 'html_url',
          created_at: 'created_at',
          pull_request_url: 'pull_request.html_url',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'list_labels',
      name: 'List Labels',
      description: 'List the labels available in a repository. Check here before applying labels to issues or PRs.',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          per_page: {
            type: 'integer',
            description: 'Results per page (max 100)',
          },
          page: {
            type: 'integer',
            description: 'Page number',
          },
        },
        required: ['owner', 'repo'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/labels',
          queryParams: {
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          name: 'name',
          description: 'description',
          color: 'color',
        },
        maxLength: 500,
      },
    },

    // ─── Read Tools: Issues ──────────────────────────────────────────────
    {
      id: 'list_issues',
      name: 'List Issues',
      description: 'List issues for a repository',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          state: {
            type: 'string',
            enum: ['open', 'closed', 'all'],
            description: 'Issue state filter',
          },
          labels: {
            type: 'string',
            description: 'Comma-separated list of label names',
          },
          sort: {
            type: 'string',
            enum: ['created', 'updated', 'comments'],
            description: 'Sort field',
          },
          per_page: {
            type: 'integer',
            description: 'Results per page (max 100)',
          },
          page: {
            type: 'integer',
            description: 'Page number',
          },
        },
        required: ['owner', 'repo'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/issues',
          queryParams: {
            state: { $param: 'state' },
            labels: { $param: 'labels' },
            sort: { $param: 'sort' },
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          number: 'number',
          title: 'title',
          state: 'state',
          html_url: 'html_url',
          user: 'user.login',
          labels: 'labels',
          created_at: 'created_at',
          pull_request_url: 'pull_request.html_url',
        },
        maxLength: 500,
      },
    },
    {
      id: 'list_issue_comments',
      name: 'List Issue Comments',
      description:
        'List comments on an issue or pull request. Returns non-inline (top-level) comments.',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          issue_number: {
            type: 'integer',
            description: 'Issue or pull request number',
          },
          since: {
            type: 'string',
            description: 'Only comments updated after this ISO 8601 timestamp',
          },
          per_page: {
            type: 'integer',
            description: 'Results per page (max 100)',
          },
          page: {
            type: 'integer',
            description: 'Page number',
          },
        },
        required: ['owner', 'repo', 'issue_number'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/issues/{issue_number}/comments',
          queryParams: {
            since: { $param: 'since' },
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          id: 'id',
          user: 'user.login',
          body: 'body',
          html_url: 'html_url',
          created_at: 'created_at',
          updated_at: 'updated_at',
        },
        maxLength: 500,
      },
    },

    // ─── Read Tools: Pull Requests ───────────────────────────────────────
    {
      id: 'get_pull_request',
      name: 'Get Pull Request',
      description: 'Get details of a specific pull request',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          pull_number: {
            type: 'integer',
            description: 'Pull request number',
          },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}',
        },
      },
      outputTransform: {
        mapping: {
          number: 'number',
          title: 'title',
          state: 'state',
          html_url: 'html_url',
          user: 'user.login',
          body: 'body',
          head_ref: 'head.ref',
          head_sha: 'head.sha',
          base_ref: 'base.ref',
          mergeable: 'mergeable',
          additions: 'additions',
          deletions: 'deletions',
          changed_files: 'changed_files',
          draft: 'draft',
          created_at: 'created_at',
        },
        maxLength: 500,
      },
    },
    {
      id: 'list_pull_requests',
      name: 'List Pull Requests',
      description: 'List pull requests for a repository',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          state: {
            type: 'string',
            enum: ['open', 'closed', 'all'],
            description: 'Pull request state filter',
          },
          sort: {
            type: 'string',
            enum: ['created', 'updated', 'popularity', 'long-running'],
            description: 'Sort field',
          },
          direction: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort direction',
          },
          per_page: {
            type: 'integer',
            description: 'Results per page (max 100)',
          },
          page: {
            type: 'integer',
            description: 'Page number',
          },
        },
        required: ['owner', 'repo'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/pulls',
          queryParams: {
            state: { $param: 'state' },
            sort: { $param: 'sort' },
            direction: { $param: 'direction' },
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          number: 'number',
          title: 'title',
          state: 'state',
          html_url: 'html_url',
          user: 'user.login',
          draft: 'draft',
          created_at: 'created_at',
        },
        maxLength: 500,
      },
    },
    {
      id: 'list_pr_files',
      name: 'List PR Files',
      description:
        'Get the list of files changed in a pull request, including patch diffs and change statistics',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          pull_number: {
            type: 'integer',
            description: 'Pull request number',
          },
          per_page: {
            type: 'integer',
            description: 'Results per page (max 100)',
          },
          page: {
            type: 'integer',
            description: 'Page number',
          },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}/files',
          queryParams: {
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          filename: 'filename',
          status: 'status',
          additions: 'additions',
          deletions: 'deletions',
          changes: 'changes',
          patch: 'patch',
          sha: 'sha',
          blob_url: 'blob_url',
        },
        maxLength: 5000,
      },
    },
    {
      id: 'list_pr_reviews',
      name: 'List PR Reviews',
      description: 'List reviews on a pull request',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          pull_number: {
            type: 'integer',
            description: 'Pull request number',
          },
          per_page: {
            type: 'integer',
            description: 'Results per page (max 100)',
          },
          page: {
            type: 'integer',
            description: 'Page number',
          },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}/reviews',
          queryParams: {
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          id: 'id',
          user: 'user.login',
          state: 'state',
          body: 'body',
          html_url: 'html_url',
          submitted_at: 'submitted_at',
        },
        maxLength: 500,
      },
    },
    {
      id: 'list_pr_review_comments',
      name: 'List PR Review Comments',
      description:
        'Get inline review comments on a pull request (comments on specific lines of code)',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          pull_number: {
            type: 'integer',
            description: 'Pull request number',
          },
          sort: {
            type: 'string',
            enum: ['created', 'updated'],
            description: 'Sort field',
          },
          direction: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort direction',
          },
          per_page: {
            type: 'integer',
            description: 'Results per page (max 100)',
          },
          page: {
            type: 'integer',
            description: 'Page number',
          },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}/comments',
          queryParams: {
            sort: { $param: 'sort' },
            direction: { $param: 'direction' },
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          id: 'id',
          body: 'body',
          path: 'path',
          line: 'line',
          side: 'side',
          user: 'user.login',
          html_url: 'html_url',
          created_at: 'created_at',
          in_reply_to_id: 'in_reply_to_id',
        },
        maxLength: 500,
      },
    },

    // ─── Write Tools ─────────────────────────────────────────────────────
    {
      id: 'create_issue',
      name: 'Create Issue',
      description: 'Create a new issue in a repository',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          title: {
            type: 'string',
            description: 'Issue title',
          },
          body: {
            type: 'string',
            description: 'Issue body (markdown)',
          },
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Labels to apply',
          },
          assignees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Usernames to assign',
          },
        },
        required: ['owner', 'repo', 'title'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/repos/{owner}/{repo}/issues',
          bodyTemplate: {
            title: { $param: 'title' },
            body: { $param: 'body' },
            labels: { $param: 'labels' },
            assignees: { $param: 'assignees' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          number: 'number',
          title: 'title',
          html_url: 'html_url',
          state: 'state',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'update_issue',
      name: 'Update Issue',
      description:
        'Update an existing issue: change title, body, state, labels, assignees, or milestone',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          issue_number: {
            type: 'integer',
            description: 'Issue number',
          },
          title: {
            type: 'string',
            description: 'New issue title',
          },
          body: {
            type: 'string',
            description: 'New issue body (markdown)',
          },
          state: {
            type: 'string',
            enum: ['open', 'closed'],
            description: 'Issue state',
          },
          state_reason: {
            type: 'string',
            enum: ['completed', 'not_planned', 'reopened', 'duplicate'],
            description: 'Reason for state change',
          },
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Labels to set (replaces all existing labels)',
          },
          assignees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Usernames to assign (replaces all existing assignees)',
          },
          milestone: {
            type: ['integer', 'null'],
            description: 'Milestone number to associate (null to clear)',
          },
        },
        required: ['owner', 'repo', 'issue_number'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'PATCH',
          pathTemplate: '/repos/{owner}/{repo}/issues/{issue_number}',
          bodyTemplate: {
            title: { $param: 'title' },
            body: { $param: 'body' },
            state: { $param: 'state' },
            state_reason: { $param: 'state_reason' },
            labels: { $param: 'labels' },
            assignees: { $param: 'assignees' },
            milestone: { $param: 'milestone' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          number: 'number',
          title: 'title',
          state: 'state',
          html_url: 'html_url',
          labels: 'labels',
          assignees: 'assignees',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'create_issue_comment',
      name: 'Create Comment',
      description:
        'Add a top-level comment to an issue or pull request. For inline code review comments, use create_pr_review or create_pr_review_comment instead.',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          issue_number: {
            type: 'integer',
            description: 'Issue or pull request number',
          },
          body: {
            type: 'string',
            description: 'Comment body (markdown)',
          },
        },
        required: ['owner', 'repo', 'issue_number', 'body'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/repos/{owner}/{repo}/issues/{issue_number}/comments',
          bodyTemplate: {
            body: { $param: 'body' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          id: 'id',
          html_url: 'html_url',
          body: 'body',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'create_pr_review',
      name: 'Create PR Review',
      description:
        'Create a review on a pull request. Can approve, request changes, or leave a comment. Optionally include inline comments on specific files and lines of code.',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          pull_number: {
            type: 'integer',
            description: 'Pull request number',
          },
          body: {
            type: 'string',
            description: 'Review summary comment (required for all events; for APPROVE it is optional on GitHub but always sent)',
          },
          event: {
            type: 'string',
            enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'],
            description: 'Review action: APPROVE, REQUEST_CHANGES, or COMMENT',
          },
          comments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'Relative file path to comment on',
                },
                line: {
                  type: 'integer',
                  description:
                    'Line number in the diff to comment on (use list_pr_files to find line numbers)',
                },
                side: {
                  type: 'string',
                  enum: ['LEFT', 'RIGHT'],
                  description: 'Which side of the diff: LEFT (deletion) or RIGHT (addition)',
                },
                body: {
                  type: 'string',
                  description: 'Comment text (markdown)',
                },
                start_line: {
                  type: 'integer',
                  description: 'Start line for multi-line comment range',
                },
                start_side: {
                  type: 'string',
                  enum: ['LEFT', 'RIGHT'],
                  description: 'Which side for the start of a multi-line comment',
                },
              },
              required: ['path', 'body', 'line'],
            },
            description: 'Array of inline comments on specific files and lines',
          },
          commit_id: {
            type: 'string',
            description: 'SHA of the commit to review (defaults to latest PR commit)',
          },
        },
        required: ['owner', 'repo', 'pull_number', 'event', 'body'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}/reviews',
          bodyTemplate: {
            body: { $param: 'body' },
            event: { $param: 'event' },
            comments: { $param: 'comments' },
            commit_id: { $param: 'commit_id' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          id: 'id',
          state: 'state',
          html_url: 'html_url',
          user: 'user.login',
          submitted_at: 'submitted_at',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'create_pr_review_comment',
      name: 'Create PR Inline Comment',
      description:
        'Add a review comment on a pull request. For inline comments: provide path, commit_id, and line. For file-level comments: provide path, commit_id, and subject_type "file". For replies: provide in_reply_to (comment ID) and body only. Use head_sha from get_pull_request for commit_id.',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          pull_number: {
            type: 'integer',
            description: 'Pull request number',
          },
          body: {
            type: 'string',
            description: 'Comment text (markdown)',
          },
          path: {
            type: 'string',
            description: 'Relative path of the file to comment on',
          },
          line: {
            type: 'integer',
            description: 'Line number in the diff to comment on',
          },
          side: {
            type: 'string',
            enum: ['LEFT', 'RIGHT'],
            description: 'Which side of the diff: LEFT (deletion) or RIGHT (addition)',
          },
          commit_id: {
            type: 'string',
            description: 'SHA of the commit to comment on (defaults to latest PR commit)',
          },
          start_line: {
            type: 'integer',
            description: 'Start line for a multi-line comment',
          },
          start_side: {
            type: 'string',
            enum: ['LEFT', 'RIGHT'],
            description: 'Which side for the start of a multi-line comment',
          },
          in_reply_to: {
            type: 'integer',
            description: 'ID of the review comment to reply to (for threaded discussions)',
          },
          subject_type: {
            type: 'string',
            enum: ['line', 'file'],
            description: 'Whether the comment is on a line or the whole file',
          },
        },
        required: ['owner', 'repo', 'pull_number', 'body'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}/comments',
          bodyTemplate: {
            body: { $param: 'body' },
            path: { $param: 'path' },
            line: { $param: 'line' },
            side: { $param: 'side' },
            commit_id: { $param: 'commit_id' },
            start_line: { $param: 'start_line' },
            start_side: { $param: 'start_side' },
            in_reply_to: { $param: 'in_reply_to' },
            subject_type: { $param: 'subject_type' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          id: 'id',
          html_url: 'html_url',
          body: 'body',
          path: 'path',
          line: 'line',
          side: 'side',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'create_branch',
      name: 'Create Branch',
      description:
        'Create a new branch in a repository from a commit SHA. Get the SHA of the branch to fork from via list_branches (commit_sha field).',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          ref: {
            type: 'string',
            description: 'Fully qualified ref for the new branch, e.g. "refs/heads/my-feature"',
          },
          sha: {
            type: 'string',
            description: 'Commit SHA the new branch points at (e.g. the default branch head from list_branches)',
          },
        },
        required: ['owner', 'repo', 'ref', 'sha'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/repos/{owner}/{repo}/git/refs',
          bodyTemplate: {
            ref: { $param: 'ref' },
            sha: { $param: 'sha' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          ref: 'ref',
          sha: 'object.sha',
          url: 'url',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'create_or_update_file',
      name: 'Create or Update File',
      description:
        'Create or update a single file in a repository with a commit message. Content must be base64-encoded. To update an existing file, pass its current blob sha (from get_repo_content). Note: writing files under .github/workflows requires a GitHub connection made after workflow permissions were added — reconnect in Settings → Integrations if GitHub rejects the write.',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          path: {
            type: 'string',
            description: 'Path of the file to create or update (e.g. "src/index.ts")',
          },
          message: {
            type: 'string',
            description: 'Commit message',
          },
          content: {
            type: 'string',
            description: 'New file content, base64-encoded',
          },
          branch: {
            type: 'string',
            description: 'Branch to commit to (defaults to the default branch)',
          },
          sha: {
            type: 'string',
            description: 'Current blob SHA of the file being replaced (required when updating an existing file)',
          },
        },
        required: ['owner', 'repo', 'path', 'message', 'content'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'PUT',
          pathTemplate: '/repos/{owner}/{repo}/contents/{path}',
          rawPathParams: ['path'],
          bodyTemplate: {
            message: { $param: 'message' },
            content: { $param: 'content' },
            branch: { $param: 'branch' },
            sha: { $param: 'sha' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          path: 'content.path',
          sha: 'content.sha',
          html_url: 'content.html_url',
          commit_sha: 'commit.sha',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'delete_file',
      name: 'Delete File',
      description:
        'Delete a file from a repository with a commit message. Requires the current blob sha of the file (from get_repo_content).',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          path: {
            type: 'string',
            description: 'Path of the file to delete',
          },
          message: {
            type: 'string',
            description: 'Commit message',
          },
          sha: {
            type: 'string',
            description: 'Current blob SHA of the file being deleted',
          },
          branch: {
            type: 'string',
            description: 'Branch to commit to (defaults to the default branch)',
          },
        },
        required: ['owner', 'repo', 'path', 'message', 'sha'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'DELETE',
          pathTemplate: '/repos/{owner}/{repo}/contents/{path}',
          rawPathParams: ['path'],
          bodyTemplate: {
            message: { $param: 'message' },
            sha: { $param: 'sha' },
            branch: { $param: 'branch' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          commit_sha: 'commit.sha',
          message: 'commit.message',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'create_pull_request',
      name: 'Create Pull Request',
      description:
        'Open a pull request from a head branch into a base branch',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          title: {
            type: 'string',
            description: 'Pull request title',
          },
          head: {
            type: 'string',
            description: 'Branch with the changes (use "user:branch" for cross-fork PRs)',
          },
          base: {
            type: 'string',
            description: 'Branch to merge into (e.g. the default branch)',
          },
          body: {
            type: 'string',
            description: 'Pull request description (markdown)',
          },
          draft: {
            type: 'boolean',
            description: 'Open as a draft pull request',
          },
        },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/repos/{owner}/{repo}/pulls',
          bodyTemplate: {
            title: { $param: 'title' },
            head: { $param: 'head' },
            base: { $param: 'base' },
            body: { $param: 'body' },
            draft: { $param: 'draft' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          number: 'number',
          title: 'title',
          state: 'state',
          html_url: 'html_url',
          head_ref: 'head.ref',
          base_ref: 'base.ref',
          draft: 'draft',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'update_pull_request',
      name: 'Update Pull Request',
      description:
        'Update a pull request: change title, body, state (open/closed), or base branch. Keep PR descriptions current as follow-up commits land.',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          pull_number: {
            type: 'integer',
            description: 'Pull request number',
          },
          title: {
            type: 'string',
            description: 'New pull request title',
          },
          body: {
            type: 'string',
            description: 'New pull request description (markdown)',
          },
          state: {
            type: 'string',
            enum: ['open', 'closed'],
            description: 'Pull request state',
          },
          base: {
            type: 'string',
            description: 'New base branch',
          },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'PATCH',
          pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}',
          bodyTemplate: {
            title: { $param: 'title' },
            body: { $param: 'body' },
            state: { $param: 'state' },
            base: { $param: 'base' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          number: 'number',
          title: 'title',
          state: 'state',
          html_url: 'html_url',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'merge_pull_request',
      name: 'Merge Pull Request',
      description:
        'Merge a pull request using merge, squash, or rebase. Check list_check_runs on the PR head SHA first to confirm CI is green.',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          owner: {
            type: 'string',
            description: 'Repository owner',
          },
          repo: {
            type: 'string',
            description: 'Repository name',
          },
          pull_number: {
            type: 'integer',
            description: 'Pull request number',
          },
          merge_method: {
            type: 'string',
            enum: ['merge', 'squash', 'rebase'],
            description: 'How to merge the pull request',
          },
          commit_title: {
            type: 'string',
            description: 'Title of the merge commit (defaults to GitHub’s standard title)',
          },
          commit_message: {
            type: 'string',
            description: 'Body of the merge commit',
          },
        },
        required: ['owner', 'repo', 'pull_number', 'merge_method'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'PUT',
          pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}/merge',
          bodyTemplate: {
            merge_method: { $param: 'merge_method' },
            commit_title: { $param: 'commit_title' },
            commit_message: { $param: 'commit_message' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          merged: 'merged',
          sha: 'sha',
          message: 'message',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
  ],
  toolBundles: [
    {
      id: 'read_only',
      name: 'Read-only',
      description: 'Browse repositories, code, branches, commits, issues, and pull requests. No writes.',
      recommended: true,
      toolIds: [
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
      ],
    },
    {
      id: 'code_review',
      name: 'Code review',
      description: 'Read pull requests, code, and CI results, then post reviews, inline comments, and replies.',
      toolIds: [
        'get_pull_request',
        'list_pull_requests',
        'list_pr_files',
        'list_pr_reviews',
        'list_pr_review_comments',
        'get_repo_content',
        'get_commit',
        'list_commits',
        'compare_refs',
        'list_check_runs',
        'create_pr_review',
        'create_pr_review_comment',
        'create_issue_comment',
      ],
    },
    {
      id: 'issue_triage',
      name: 'Issue triage',
      description: 'Read, search, open, update, and comment on issues.',
      toolIds: [
        'list_issues',
        'list_issue_comments',
        'search_issues',
        'list_labels',
        'create_issue',
        'update_issue',
        'create_issue_comment',
      ],
    },
    {
      id: 'contributor',
      name: 'Contributor',
      description: 'Create branches, commit files, and open, update, and merge pull requests.',
      toolIds: [
        'list_repos',
        'get_repo',
        'get_repo_content',
        'get_repo_tree',
        'list_branches',
        'get_commit',
        'list_commits',
        'compare_refs',
        'list_check_runs',
        'get_pull_request',
        'list_pull_requests',
        'list_pr_files',
        'create_branch',
        'create_or_update_file',
        'delete_file',
        'create_pull_request',
        'update_pull_request',
        'merge_pull_request',
        'create_issue_comment',
      ],
    },
    {
      id: 'full',
      name: 'Full access',
      description: 'Every GitHub tool — read and write across repos, code, issues, pull requests, and CI.',
      toolIds: [
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
      ],
    },
  ],
};
