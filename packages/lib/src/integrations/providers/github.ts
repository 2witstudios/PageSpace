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
  description: 'Access GitHub repositories, issues, and pull requests',
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
    // ─── Read Tools ──────────────────────────────────────────────────────
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
          head_ref: 'head.ref',
          base_ref: 'base.ref',
          mergeable: 'mergeable',
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
  ],
};
