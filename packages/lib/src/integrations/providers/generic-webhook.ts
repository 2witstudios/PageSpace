/**
 * Generic Webhook Provider Adapter
 *
 * Sends HTTP requests to arbitrary webhook URLs.
 * The actual URL comes from connection.baseUrlOverride at runtime;
 * baseUrl here is a placeholder the execution saga replaces.
 *
 * Path encoding: The `path` parameter is interpolated into the URL pathname
 * via `interpolatePath` (which performs no encoding), then passed through the
 * WHATWG URL API's `pathname` setter, which percent-encodes characters that
 * are invalid in a URL path component. This means:
 *   - `?` is encoded to `%3F` (not treated as a query delimiter)
 *   - `#` is encoded to `%23` (not treated as a fragment delimiter)
 *   - Spaces are encoded to `%20`
 *   - Unicode characters are percent-encoded
 *   - `/`, `&`, `=`, `:`, `@` pass through unencoded
 * Callers cannot embed query strings in the `path` parameter; use
 * `connection.baseUrlOverride` to set the full URL including query string.
 */

import type { IntegrationProviderConfig } from '../types';

export const genericWebhookProvider: IntegrationProviderConfig = {
  id: 'generic-webhook',
  name: 'Generic Webhook',
  description: 'Send HTTP requests to any webhook URL',
  authMethod: {
    type: 'custom_header',
    config: {
      headers: [
        {
          name: 'X-Webhook-Secret',
          valueFrom: 'credential',
          credentialKey: 'webhookSecret',
        },
      ],
    },
  },
  baseUrl: 'https://placeholder.invalid',
  defaultHeaders: {
    'User-Agent': 'PageSpace-Webhook/1.0',
  },
  credentialSchema: {
    type: 'object',
    properties: {
      webhookSecret: {
        type: 'string',
        description: 'Optional secret sent in X-Webhook-Secret header',
      },
    },
    required: [],
  },
  rateLimit: { requests: 60, windowMs: 60_000 },
  tools: [
    {
      id: 'send_webhook',
      name: 'Send Webhook',
      description: 'Send a JSON POST request to the webhook URL',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          body: {
            type: 'object',
            description: 'JSON payload to send',
          },
          path: {
            type: 'string',
            description: 'Optional path appended to the webhook URL',
          },
        },
        required: ['body'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/{path}',
          bodyTemplate: { $param: 'body' },
          bodyEncoding: 'json',
        },
      },
    },
    {
      id: 'send_get_webhook',
      name: 'Send GET Webhook',
      description: 'Send a GET request to the webhook URL',
      category: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Optional path segment appended to the webhook URL. Special characters (?, #, spaces) are percent-encoded by the URL API.',
          },
        },
        required: [],
      },
      execution: {
        type: 'http',
        config: {
          method: 'GET',
          pathTemplate: '/{path}',
        },
      },
    },
    {
      id: 'send_form_webhook',
      name: 'Send Form Webhook',
      description: 'Send a form-encoded POST request to the webhook URL',
      category: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          body: {
            type: 'object',
            description: 'Form data to send as URL-encoded body',
          },
          path: {
            type: 'string',
            description: 'Optional path appended to the webhook URL',
          },
        },
        required: ['body'],
      },
      execution: {
        type: 'http',
        config: {
          method: 'POST',
          pathTemplate: '/{path}',
          bodyTemplate: { $param: 'body' },
          bodyEncoding: 'form',
        },
      },
    },
  ],
};
