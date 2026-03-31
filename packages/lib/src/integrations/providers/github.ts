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
      scopes: ['repo', 'read:user'],
      pkceRequired: false,
    },
  },
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
        'Read file content or list directory contents from a repository. For files, returns base64-encoded content in the "content" field. For directories, returns an array of entries with name, path, type, and size.',
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
            description: 'Path to file or directory (e.g. "src/index.ts" or "docs")',
          },
          ref: {
            type: 'string',
            description: 'Branch, tag, or commit SHA (defaults to default branch)',
          },
        },
        required: ['owner', 'repo', 'path'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/contents/{path}',
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
        'Get the full file tree of a repository at a given branch or commit SHA. Returns all files and directories recursively. For very large repos, the response may be truncated.',
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
          recursive: {
            type: 'string',
            enum: ['1'],
            description: 'Set to "1" to retrieve tree recursively (includes all subdirectories)',
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
            recursive: { $param: 'recursive' },
          },
        },
      },
      outputTransform: {
        extract: '$.tree',
        mapping: {
          path: 'path',
          type: 'type',
          mode: 'mode',
          size: 'size',
          sha: 'sha',
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

    // ─── Read Tools: Issues ──────────────────────────────────────────────
    {
      id: 'get_issues',
      name: 'Get Issues',
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
      id: 'get_pr_diff',
      name: 'Get PR Files',
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
      id: 'get_pr_reviews',
      name: 'Get PR Reviews',
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
      id: 'get_pr_review_comments',
      name: 'Get PR Review Comments',
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
            enum: ['completed', 'not_planned', 'reopened'],
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
            type: 'integer',
            description: 'Milestone number to associate',
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
            description: 'Review summary comment (required for REQUEST_CHANGES and COMMENT events)',
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
                    'Line number in the diff to comment on (use get_pr_diff to find line numbers)',
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
        required: ['owner', 'repo', 'pull_number', 'event'],
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
        'Add a single inline review comment on a specific line of a pull request diff. For multi-line comments, specify start_line and start_side.',
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
        required: ['owner', 'repo', 'pull_number', 'body', 'path'],
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
  ],
};
