/**
 * GitHub Provider Adapter
 *
 * Provides AI agents with comprehensive access to GitHub repositories,
 * issues, pull requests, code, commits, branches, and reviews via
 * the GitHub REST API v3. Designed for full gh CLI-like capabilities.
 */

import type { IntegrationProviderConfig } from '../types';

export const githubProvider: IntegrationProviderConfig = {
  id: 'github',
  name: 'GitHub',
  description: 'Full access to GitHub repositories, code, issues, pull requests, reviews, commits, and branches',
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
    // ═══════════════════════════════════════════════════════════════════════
    // READ TOOLS - Repositories
    // ═══════════════════════════════════════════════════════════════════════
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
      description: 'Get detailed information about a specific repository including default branch, visibility, topics, and statistics',
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
          html_url: 'html_url',
          description: 'description',
          language: 'language',
          default_branch: 'default_branch',
          stargazers_count: 'stargazers_count',
          forks_count: 'forks_count',
          open_issues_count: 'open_issues_count',
          topics: 'topics',
          private: 'private',
          archived: 'archived',
          created_at: 'created_at',
          updated_at: 'updated_at',
          pushed_at: 'pushed_at',
        },
        maxLength: 500,
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // READ TOOLS - File Content & Trees
    // ═══════════════════════════════════════════════════════════════════════
    {
      id: 'get_file_content',
      name: 'Get File Content',
      description: 'Read the content of a file from a repository at a specific path and ref (branch, tag, or commit SHA). Returns the decoded file content.',
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
            description: 'File path within the repository (e.g. "src/index.ts")',
          },
          ref: {
            type: 'string',
            description: 'Branch name, tag, or commit SHA (defaults to default branch)',
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
          sha: 'sha',
          size: 'size',
          type: 'type',
          content: 'content',
          encoding: 'encoding',
          html_url: 'html_url',
        },
        maxLength: 10000,
      },
    },
    {
      id: 'get_tree',
      name: 'Get Repository Tree',
      description: 'Get the file/directory tree of a repository at a specific ref. Use recursive=true to get the full tree. Equivalent to listing directory contents.',
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
            description: 'Set to "1" to recursively get the entire tree',
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
        mapping: {
          sha: 'sha',
          tree: 'tree',
          truncated: 'truncated',
        },
        maxLength: 10000,
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // READ TOOLS - Issues
    // ═══════════════════════════════════════════════════════════════════════
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
      id: 'get_issue',
      name: 'Get Issue',
      description: 'Get details of a specific issue including body, labels, assignees, and milestone',
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
            description: 'Issue number',
          },
        },
        required: ['owner', 'repo', 'issue_number'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/issues/{issue_number}',
        },
      },
      outputTransform: {
        mapping: {
          number: 'number',
          title: 'title',
          state: 'state',
          body: 'body',
          html_url: 'html_url',
          user: 'user.login',
          labels: 'labels',
          assignees: 'assignees',
          milestone: 'milestone',
          comments: 'comments',
          created_at: 'created_at',
          updated_at: 'updated_at',
          closed_at: 'closed_at',
        },
        maxLength: 5000,
      },
    },
    {
      id: 'list_issue_comments',
      name: 'List Issue Comments',
      description: 'List comments on an issue or pull request',
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
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          id: 'id',
          body: 'body',
          user: 'user.login',
          html_url: 'html_url',
          created_at: 'created_at',
          updated_at: 'updated_at',
        },
        maxLength: 5000,
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // READ TOOLS - Pull Requests
    // ═══════════════════════════════════════════════════════════════════════
    {
      id: 'get_pull_request',
      name: 'Get Pull Request',
      description: 'Get details of a specific pull request including title, body, head/base refs, mergeable status, and diff stats',
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
          body: 'body',
          state: 'state',
          html_url: 'html_url',
          user: 'user.login',
          head_ref: 'head.ref',
          head_sha: 'head.sha',
          base_ref: 'base.ref',
          base_sha: 'base.sha',
          mergeable: 'mergeable',
          mergeable_state: 'mergeable_state',
          draft: 'draft',
          additions: 'additions',
          deletions: 'deletions',
          changed_files: 'changed_files',
          commits: 'commits',
          comments: 'comments',
          review_comments: 'review_comments',
          created_at: 'created_at',
          updated_at: 'updated_at',
          merged_at: 'merged_at',
        },
        maxLength: 5000,
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
          head: {
            type: 'string',
            description: 'Filter by head user/org and branch (e.g. "user:branch")',
          },
          base: {
            type: 'string',
            description: 'Filter by base branch name',
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
            head: { $param: 'head' },
            base: { $param: 'base' },
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
          head_ref: 'head.ref',
          base_ref: 'base.ref',
          draft: 'draft',
          created_at: 'created_at',
        },
        maxLength: 500,
      },
    },
    {
      id: 'list_pr_files',
      name: 'List PR Files',
      description: 'List files changed in a pull request with patch diffs, status (added/modified/removed), and line change counts',
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
          sha: 'sha',
          filename: 'filename',
          status: 'status',
          additions: 'additions',
          deletions: 'deletions',
          changes: 'changes',
          patch: 'patch',
          blob_url: 'blob_url',
          raw_url: 'raw_url',
          previous_filename: 'previous_filename',
        },
        maxLength: 10000,
      },
    },
    {
      id: 'get_pr_diff',
      name: 'Get PR Diff',
      description: 'Get the full unified diff of a pull request as a patch. Returns raw diff text showing all changes.',
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
          headers: {
            'Accept': 'application/vnd.github.v3.diff',
          },
        },
      },
      outputTransform: {
        maxLength: 50000,
      },
    },
    {
      id: 'list_pr_commits',
      name: 'List PR Commits',
      description: 'List commits on a pull request',
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
          pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}/commits',
          queryParams: {
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          sha: 'sha',
          message: 'commit.message',
          author: 'commit.author.name',
          author_date: 'commit.author.date',
          committer: 'commit.committer.name',
          html_url: 'html_url',
        },
        maxLength: 5000,
      },
    },
    {
      id: 'get_pr_reviews',
      name: 'Get PR Reviews',
      description: 'List reviews on a pull request including approval status, comments, and reviewer details',
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
        maxLength: 5000,
      },
    },
    {
      id: 'list_pr_review_comments',
      name: 'List PR Review Comments',
      description: 'List inline review comments on a pull request, including file path, line number, and diff context',
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
          start_line: 'start_line',
          start_side: 'start_side',
          diff_hunk: 'diff_hunk',
          user: 'user.login',
          html_url: 'html_url',
          in_reply_to_id: 'in_reply_to_id',
          created_at: 'created_at',
          updated_at: 'updated_at',
        },
        maxLength: 10000,
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // READ TOOLS - Commits & Branches
    // ═══════════════════════════════════════════════════════════════════════
    {
      id: 'list_commits',
      name: 'List Commits',
      description: 'List commits on a repository branch or path. Can filter by author, date range, and file path.',
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
            description: 'Branch name or commit SHA to start listing from',
          },
          path: {
            type: 'string',
            description: 'Only commits containing this file path',
          },
          author: {
            type: 'string',
            description: 'GitHub username or email to filter by',
          },
          since: {
            type: 'string',
            description: 'ISO 8601 date - only commits after this date',
          },
          until: {
            type: 'string',
            description: 'ISO 8601 date - only commits before this date',
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
            author: { $param: 'author' },
            since: { $param: 'since' },
            until: { $param: 'until' },
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          sha: 'sha',
          message: 'commit.message',
          author: 'commit.author.name',
          author_email: 'commit.author.email',
          date: 'commit.author.date',
          html_url: 'html_url',
        },
        maxLength: 5000,
      },
    },
    {
      id: 'get_commit',
      name: 'Get Commit',
      description: 'Get a specific commit by SHA including full diff stats, files changed, and parent commits',
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
            description: 'Commit SHA, branch name, or tag',
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
          author: 'commit.author.name',
          author_email: 'commit.author.email',
          date: 'commit.author.date',
          html_url: 'html_url',
          stats: 'stats',
          files: 'files',
          parents: 'parents',
        },
        maxLength: 10000,
      },
    },
    {
      id: 'compare_commits',
      name: 'Compare Commits',
      description: 'Compare two commits, branches, or tags. Shows the diff, files changed, and commits between them. Use "base...head" format.',
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
          basehead: {
            type: 'string',
            description: 'Comparison in "base...head" format (e.g. "main...feature-branch")',
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
        required: ['owner', 'repo', 'basehead'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/compare/{basehead}',
          queryParams: {
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          status: 'status',
          ahead_by: 'ahead_by',
          behind_by: 'behind_by',
          total_commits: 'total_commits',
          commits: 'commits',
          files: 'files',
          html_url: 'html_url',
        },
        maxLength: 10000,
      },
    },
    {
      id: 'list_branches',
      name: 'List Branches',
      description: 'List branches in a repository with optional protection status',
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
            type: 'string',
            enum: ['true', 'false'],
            description: 'Filter by protected status',
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
            protected: { $param: 'protected' },
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
      id: 'get_branch',
      name: 'Get Branch',
      description: 'Get details of a specific branch including the latest commit and protection rules',
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
            description: 'Branch name',
          },
        },
        required: ['owner', 'repo', 'branch'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/repos/{owner}/{repo}/branches/{branch}',
        },
      },
      outputTransform: {
        mapping: {
          name: 'name',
          protected: 'protected',
          commit_sha: 'commit.sha',
          commit_message: 'commit.commit.message',
          commit_author: 'commit.commit.author.name',
          commit_date: 'commit.commit.author.date',
        },
        maxLength: 500,
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // READ TOOLS - Search
    // ═══════════════════════════════════════════════════════════════════════
    {
      id: 'search_code',
      name: 'Search Code',
      description: 'Search for code across GitHub repositories. Use qualifiers like "repo:owner/name", "language:typescript", "path:src/", "extension:ts"',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          q: {
            type: 'string',
            description: 'Search query with optional qualifiers (e.g. "addClass repo:jquery/jquery language:js")',
          },
          sort: {
            type: 'string',
            enum: ['indexed'],
            description: 'Sort by last indexed time',
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
        mapping: {
          total_count: 'total_count',
          items: 'items',
        },
        maxLength: 10000,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'search_issues',
      name: 'Search Issues & PRs',
      description: 'Search issues and pull requests across GitHub. Use qualifiers like "repo:owner/name", "is:pr", "is:open", "label:bug", "author:user"',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          q: {
            type: 'string',
            description: 'Search query with qualifiers (e.g. "bug is:open repo:owner/repo label:critical")',
          },
          sort: {
            type: 'string',
            enum: ['comments', 'reactions', 'reactions-+1', 'reactions--1', 'reactions-smile', 'reactions-thinking_face', 'reactions-heart', 'reactions-tada', 'interactions', 'created', 'updated'],
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
        mapping: {
          total_count: 'total_count',
          items: 'items',
        },
        maxLength: 5000,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // READ TOOLS - Labels & Releases
    // ═══════════════════════════════════════════════════════════════════════
    {
      id: 'list_labels',
      name: 'List Labels',
      description: 'List all labels in a repository',
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
          id: 'id',
          name: 'name',
          description: 'description',
          color: 'color',
        },
        maxLength: 500,
      },
    },
    {
      id: 'list_releases',
      name: 'List Releases',
      description: 'List releases for a repository including tag names, assets, and release notes',
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
          pathTemplate: '/repos/{owner}/{repo}/releases',
          queryParams: {
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          id: 'id',
          tag_name: 'tag_name',
          name: 'name',
          body: 'body',
          draft: 'draft',
          prerelease: 'prerelease',
          html_url: 'html_url',
          created_at: 'created_at',
          published_at: 'published_at',
        },
        maxLength: 5000,
      },
    },
    {
      id: 'list_check_runs',
      name: 'List Check Runs',
      description: 'List check runs (CI/CD status checks) for a specific commit ref, branch, or tag',
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
            description: 'Commit SHA, branch name, or tag',
          },
          status: {
            type: 'string',
            enum: ['queued', 'in_progress', 'completed'],
            description: 'Filter by status',
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
            status: { $param: 'status' },
            per_page: { $param: 'per_page', transform: 'string' },
            page: { $param: 'page', transform: 'string' },
          },
        },
      },
      outputTransform: {
        mapping: {
          total_count: 'total_count',
          check_runs: 'check_runs',
        },
        maxLength: 5000,
      },
    },

    // ═══════════════════════════════════════════════════════════════════════
    // WRITE TOOLS
    // ═══════════════════════════════════════════════════════════════════════
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
      description: 'Update an existing issue - change title, body, state (open/closed), labels, assignees, or milestone',
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
            description: 'New title',
          },
          body: {
            type: 'string',
            description: 'New body (markdown)',
          },
          state: {
            type: 'string',
            enum: ['open', 'closed'],
            description: 'Issue state',
          },
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Replace all labels with these',
          },
          assignees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Replace all assignees with these usernames',
          },
          milestone: {
            type: 'integer',
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
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'create_pr_comment',
      name: 'Create PR Comment',
      description: 'Add a comment to a pull request (or issue)',
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
      id: 'create_pull_request',
      name: 'Create Pull Request',
      description: 'Create a new pull request from a head branch to a base branch',
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
          body: {
            type: 'string',
            description: 'Pull request description (markdown)',
          },
          head: {
            type: 'string',
            description: 'The branch containing changes (e.g. "feature-branch" or "user:feature-branch" for cross-repo)',
          },
          base: {
            type: 'string',
            description: 'The branch to merge into (e.g. "main")',
          },
          draft: {
            type: 'boolean',
            description: 'Create as draft PR',
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
            body: { $param: 'body' },
            head: { $param: 'head' },
            base: { $param: 'base' },
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
      id: 'create_pr_review',
      name: 'Create PR Review',
      description: 'Submit a review on a pull request - approve, request changes, or comment. Can include inline comments on specific files and lines.',
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
            description: 'Review summary body (markdown)',
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
                  description: 'File path relative to repo root',
                },
                line: {
                  type: 'integer',
                  description: 'Line number in the diff to comment on',
                },
                side: {
                  type: 'string',
                  enum: ['LEFT', 'RIGHT'],
                  description: 'Side of the diff (LEFT=base, RIGHT=head)',
                },
                body: {
                  type: 'string',
                  description: 'Comment body (markdown)',
                },
                start_line: {
                  type: 'integer',
                  description: 'First line of a multi-line comment range',
                },
                start_side: {
                  type: 'string',
                  enum: ['LEFT', 'RIGHT'],
                  description: 'Side of the diff for start_line',
                },
              },
              required: ['path', 'body'],
            },
            description: 'Inline review comments on specific files/lines',
          },
          commit_id: {
            type: 'string',
            description: 'SHA of the commit to review (defaults to latest)',
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
          body: 'body',
          user: 'user.login',
          submitted_at: 'submitted_at',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'create_pr_review_comment',
      name: 'Create PR Review Comment',
      description: 'Add an inline review comment on a specific file and line in a pull request diff',
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
            description: 'Comment body (markdown)',
          },
          path: {
            type: 'string',
            description: 'File path relative to repo root',
          },
          line: {
            type: 'integer',
            description: 'Line number in the diff to comment on',
          },
          side: {
            type: 'string',
            enum: ['LEFT', 'RIGHT'],
            description: 'Side of the diff (LEFT=base file, RIGHT=head/changed file)',
          },
          commit_id: {
            type: 'string',
            description: 'SHA of the commit to comment on',
          },
          start_line: {
            type: 'integer',
            description: 'First line of a multi-line comment range',
          },
          start_side: {
            type: 'string',
            enum: ['LEFT', 'RIGHT'],
            description: 'Side of the diff for start_line',
          },
          in_reply_to: {
            type: 'integer',
            description: 'ID of the review comment to reply to',
          },
          subject_type: {
            type: 'string',
            enum: ['line', 'file'],
            description: 'Whether to comment on a line or file',
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
          body: 'body',
          path: 'path',
          line: 'line',
          html_url: 'html_url',
          user: 'user.login',
          created_at: 'created_at',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'merge_pull_request',
      name: 'Merge Pull Request',
      description: 'Merge a pull request using merge commit, squash, or rebase strategy',
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
          commit_title: {
            type: 'string',
            description: 'Title for the merge commit',
          },
          commit_message: {
            type: 'string',
            description: 'Message for the merge commit',
          },
          merge_method: {
            type: 'string',
            enum: ['merge', 'squash', 'rebase'],
            description: 'Merge method to use',
          },
          sha: {
            type: 'string',
            description: 'SHA that the head must match to prevent stale merges',
          },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'PUT',
          pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}/merge',
          bodyTemplate: {
            commit_title: { $param: 'commit_title' },
            commit_message: { $param: 'commit_message' },
            merge_method: { $param: 'merge_method' },
            sha: { $param: 'sha' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          sha: 'sha',
          merged: 'merged',
          message: 'message',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 5, windowMs: 60_000 },
    },
    {
      id: 'request_reviewers',
      name: 'Request Reviewers',
      description: 'Request reviewers for a pull request by username or team slug',
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
          reviewers: {
            type: 'array',
            items: { type: 'string' },
            description: 'GitHub usernames to request reviews from',
          },
          team_reviewers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Team slugs to request reviews from',
          },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers',
          bodyTemplate: {
            reviewers: { $param: 'reviewers' },
            team_reviewers: { $param: 'team_reviewers' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          number: 'number',
          title: 'title',
          html_url: 'html_url',
          requested_reviewers: 'requested_reviewers',
          requested_teams: 'requested_teams',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'add_labels',
      name: 'Add Labels',
      description: 'Add labels to an issue or pull request',
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
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Label names to add',
          },
        },
        required: ['owner', 'repo', 'issue_number', 'labels'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/repos/{owner}/{repo}/issues/{issue_number}/labels',
          bodyTemplate: {
            labels: { $param: 'labels' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          id: 'id',
          name: 'name',
          color: 'color',
          description: 'description',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'remove_label',
      name: 'Remove Label',
      description: 'Remove a label from an issue or pull request',
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
          name: {
            type: 'string',
            description: 'Label name to remove',
          },
        },
        required: ['owner', 'repo', 'issue_number', 'name'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'DELETE',
          pathTemplate: '/repos/{owner}/{repo}/issues/{issue_number}/labels/{name}',
        },
      },
      outputTransform: {
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
  ],
};
