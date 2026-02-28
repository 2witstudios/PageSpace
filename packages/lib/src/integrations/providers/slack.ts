/**
 * Slack Provider Adapter
 *
 * Provides AI agents with access to Slack channels, messages,
 * and user information via the Slack Web API.
 */

import type { IntegrationProviderConfig } from '../types';

const SLACK_RESPONSE_VALIDATION = {
  success: { path: '$.ok', equals: true },
  errorPath: '$.error',
} as const;

export const slackProvider: IntegrationProviderConfig = {
  id: 'slack',
  name: 'Slack',
  description: 'Access Slack channels, messages, and users',
  documentationUrl: 'https://api.slack.com/methods',
  authMethod: {
    type: 'oauth2',
    config: {
      authorizationUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      revokeUrl: 'https://slack.com/api/auth.revoke',
      scopes: [
        'channels:read',
        'channels:history',
        'groups:read',
        'groups:history',
        'chat:write',
        'users:read',
        'users:read.email',
        'search:read',
      ],
      pkceRequired: false,
    },
  },
  baseUrl: 'https://slack.com/api',
  defaultHeaders: {
    'Content-Type': 'application/json; charset=utf-8',
  },
  healthCheck: {
    endpoint: '/auth.test',
    expectedStatus: 200,
  },
  credentialSchema: {
    type: 'object',
    properties: {
      accessToken: {
        type: 'string',
        description: 'OAuth2 bot access token',
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
      id: 'list_channels',
      name: 'List Channels',
      description: 'List accessible channels in the workspace',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'integer',
            description: 'Maximum number of channels to return (max 1000)',
          },
          cursor: {
            type: 'string',
            description: 'Pagination cursor for next page',
          },
          types: {
            type: 'string',
            description: 'Comma-separated channel types (public_channel, private_channel)',
          },
        },
        required: [],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/conversations.list',
          queryParams: {
            limit: { $param: 'limit', transform: 'string' },
            cursor: { $param: 'cursor' },
            types: { $param: 'types' },
          },
        },
      },
      responseValidation: SLACK_RESPONSE_VALIDATION,
      outputTransform: {
        extract: '$.channels',
        mapping: {
          id: 'id',
          name: 'name',
          topic: 'topic.value',
          purpose: 'purpose.value',
          num_members: 'num_members',
          is_private: 'is_private',
        },
        maxLength: 500,
      },
    },
    {
      id: 'list_messages',
      name: 'List Messages',
      description: 'Fetch recent messages from a channel',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description: 'Channel ID',
          },
          limit: {
            type: 'integer',
            description: 'Number of messages to return (max 1000)',
          },
          cursor: {
            type: 'string',
            description: 'Pagination cursor for next page',
          },
        },
        required: ['channel'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/conversations.history',
          queryParams: {
            channel: { $param: 'channel' },
            limit: { $param: 'limit', transform: 'string' },
            cursor: { $param: 'cursor' },
          },
        },
      },
      responseValidation: SLACK_RESPONSE_VALIDATION,
      outputTransform: {
        extract: '$.messages',
        mapping: {
          ts: 'ts',
          text: 'text',
          user: 'user',
          type: 'type',
          thread_ts: 'thread_ts',
        },
        maxLength: 500,
      },
    },
    {
      id: 'get_user_info',
      name: 'Get User Info',
      description: 'Get details about a Slack user',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          user: {
            type: 'string',
            description: 'Slack user ID',
          },
        },
        required: ['user'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/users.info',
          queryParams: {
            user: { $param: 'user' },
          },
        },
      },
      responseValidation: SLACK_RESPONSE_VALIDATION,
      outputTransform: {
        extract: '$.user',
        mapping: {
          id: 'id',
          name: 'name',
          real_name: 'real_name',
          display_name: 'profile.display_name',
          email: 'profile.email',
          is_bot: 'is_bot',
          tz: 'tz',
        },
        maxLength: 500,
      },
    },
    {
      id: 'search_messages',
      name: 'Search Messages',
      description: 'Search for messages across the workspace',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query string',
          },
          sort: {
            type: 'string',
            enum: ['score', 'timestamp'],
            description: 'Sort order for results',
          },
          count: {
            type: 'integer',
            description: 'Number of results to return (max 100)',
          },
        },
        required: ['query'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/search.messages',
          queryParams: {
            query: { $param: 'query' },
            sort: { $param: 'sort' },
            count: { $param: 'count', transform: 'string' },
          },
        },
      },
      responseValidation: SLACK_RESPONSE_VALIDATION,
      outputTransform: {
        extract: '$.messages.matches',
        mapping: {
          text: 'text',
          ts: 'ts',
          user: 'username',
          channel: 'channel.name',
          permalink: 'permalink',
        },
        maxLength: 500,
      },
    },

    // ─── Write Tools ─────────────────────────────────────────────────────
    {
      id: 'send_message',
      name: 'Send Message',
      description: 'Post a message to a Slack channel',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description: 'Channel ID to post to',
          },
          text: {
            type: 'string',
            description: 'Message text',
          },
          thread_ts: {
            type: 'string',
            description: 'Thread timestamp to reply in a thread',
          },
        },
        required: ['channel', 'text'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/chat.postMessage',
          bodyTemplate: {
            channel: { $param: 'channel' },
            text: { $param: 'text' },
            thread_ts: { $param: 'thread_ts' },
          },
          bodyEncoding: 'json',
        },
      },
      responseValidation: SLACK_RESPONSE_VALIDATION,
      outputTransform: {
        mapping: {
          ts: 'ts',
          channel: 'channel',
          message_text: 'message.text',
        },
        maxLength: 500,
      },
      rateLimit: { requests: 10, windowMs: 60_000 },
    },
  ],
};
