/**
 * Notion Provider Adapter
 *
 * Provides AI agents with access to Notion workspaces, pages,
 * and databases via the Notion REST API.
 */

import type { IntegrationProviderConfig } from '../types';

export const notionProvider: IntegrationProviderConfig = {
  id: 'notion',
  name: 'Notion',
  description: 'Access Notion pages, databases, and workspace content',
  documentationUrl: 'https://developers.notion.com/reference',
  authMethod: {
    type: 'oauth2',
    config: {
      authorizationUrl: 'https://api.notion.com/v1/oauth/authorize',
      tokenUrl: 'https://api.notion.com/v1/oauth/token',
      scopes: [],
      pkceRequired: false,
    },
  },
  baseUrl: 'https://api.notion.com/v1',
  defaultHeaders: {
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  },
  healthCheck: {
    endpoint: '/users/me',
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
      workspaceId: {
        type: 'string',
        description: 'Notion workspace ID',
      },
    },
    required: ['accessToken'],
  },
  rateLimit: { requests: 180, windowMs: 60_000 },
  tools: [
    // ─── Read Tools ──────────────────────────────────────────────────────
    {
      id: 'search',
      name: 'Search',
      description: 'Search across a Notion workspace for pages and databases',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query text',
          },
          filter: {
            type: 'object',
            description:
              'Filter object: { property: "object", value: "page" | "database" }',
          },
          sort: {
            type: 'object',
            description:
              'Sort object: { timestamp: "last_edited_time", direction: "ascending" | "descending" }',
          },
          page_size: {
            type: 'integer',
            description: 'Number of results to return (max 100)',
          },
          start_cursor: {
            type: 'string',
            description: 'Pagination cursor from a previous response',
          },
        },
        required: [],
      },
      execution: {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/search',
          bodyTemplate: {
            query: { $param: 'query' },
            filter: { $param: 'filter' },
            sort: { $param: 'sort' },
            page_size: { $param: 'page_size' },
            start_cursor: { $param: 'start_cursor' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        extract: '$.results',
        maxLength: 500,
      },
    },
    {
      id: 'get_page',
      name: 'Get Page',
      description: 'Retrieve a Notion page and its properties by ID',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: {
            type: 'string',
            description: 'The ID of the Notion page',
          },
        },
        required: ['page_id'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/pages/{page_id}',
        },
      },
      outputTransform: {
        mapping: {
          id: 'id',
          url: 'url',
          created_time: 'created_time',
          last_edited_time: 'last_edited_time',
          properties: 'properties',
          parent: 'parent',
        },
        maxLength: 500,
      },
    },
    {
      id: 'get_database',
      name: 'Get Database',
      description: 'Retrieve a Notion database schema and metadata by ID',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          database_id: {
            type: 'string',
            description: 'The ID of the Notion database',
          },
        },
        required: ['database_id'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/databases/{database_id}',
        },
      },
      outputTransform: {
        mapping: {
          id: 'id',
          title: 'title',
          description: 'description',
          properties: 'properties',
          url: 'url',
          created_time: 'created_time',
          last_edited_time: 'last_edited_time',
        },
        maxLength: 500,
      },
    },
    {
      id: 'query_database',
      name: 'Query Database',
      description: 'Query a Notion database with optional filters and sorts',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          database_id: {
            type: 'string',
            description: 'The ID of the Notion database to query',
          },
          filter: {
            type: 'object',
            description: 'Notion filter object',
          },
          sorts: {
            type: 'array',
            items: { type: 'object' },
            description: 'Array of sort objects',
          },
          page_size: {
            type: 'integer',
            description: 'Number of results to return (max 100)',
          },
          start_cursor: {
            type: 'string',
            description: 'Pagination cursor from a previous response',
          },
        },
        required: ['database_id'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/databases/{database_id}/query',
          bodyTemplate: {
            filter: { $param: 'filter' },
            sorts: { $param: 'sorts' },
            page_size: { $param: 'page_size' },
            start_cursor: { $param: 'start_cursor' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        extract: '$.results',
        maxLength: 500,
      },
    },

    // ─── Write Tools ─────────────────────────────────────────────────────
    {
      id: 'update_page',
      name: 'Update Page',
      description: 'Update properties or metadata of an existing Notion page',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: {
            type: 'string',
            description: 'The ID of the page to update',
          },
          properties: {
            type: 'object',
            description: 'Page properties to update (Notion property value objects)',
          },
          archived: {
            type: 'boolean',
            description: 'Set to true to archive (delete) the page',
          },
          icon: {
            type: 'object',
            description: 'Page icon (emoji or external URL)',
          },
          cover: {
            type: 'object',
            description: 'Page cover image (external URL)',
          },
        },
        required: ['page_id'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'PATCH',
          pathTemplate: '/pages/{page_id}',
          bodyTemplate: {
            properties: { $param: 'properties' },
            archived: { $param: 'archived' },
            icon: { $param: 'icon' },
            cover: { $param: 'cover' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          id: 'id',
          url: 'url',
          last_edited_time: 'last_edited_time',
          properties: 'properties',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
    {
      id: 'create_page',
      name: 'Create Page',
      description: 'Create a new Notion page in a database or as a child of another page',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          parent: {
            type: 'object',
            description: 'Parent reference: { database_id: "..." } or { page_id: "..." }',
          },
          properties: {
            type: 'object',
            description: 'Page properties (Notion property value objects)',
          },
          children: {
            type: 'array',
            items: { type: 'object' },
            description: 'Page content as an array of block objects',
          },
          icon: {
            type: 'object',
            description: 'Page icon (emoji or external URL)',
          },
          cover: {
            type: 'object',
            description: 'Page cover image (external URL)',
          },
        },
        required: ['parent', 'properties'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/pages',
          bodyTemplate: {
            parent: { $param: 'parent' },
            properties: { $param: 'properties' },
            children: { $param: 'children' },
            icon: { $param: 'icon' },
            cover: { $param: 'cover' },
          },
          bodyEncoding: 'json',
        },
      },
      outputTransform: {
        mapping: {
          id: 'id',
          url: 'url',
          created_time: 'created_time',
          parent: 'parent',
          properties: 'properties',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
  ],
};
