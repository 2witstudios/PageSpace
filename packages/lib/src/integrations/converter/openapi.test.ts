import { describe, it, expect } from 'vitest';
import { importOpenAPISpec } from './openapi';

// ═══════════════════════════════════════════════════════════════════════════════
// MINIMAL SPEC
// ═══════════════════════════════════════════════════════════════════════════════

const minimalSpec = {
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0.0' },
  servers: [{ url: 'https://api.test.com' }],
  paths: {
    '/items': {
      get: {
        operationId: 'listItems',
        summary: 'List items',
        description: 'List all items',
        parameters: [
          { name: 'page', in: 'query' as const, schema: { type: 'integer' }, description: 'Page number' },
        ],
        responses: { '200': { description: 'Success' } },
      },
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// FULL-FEATURED SPEC
// ═══════════════════════════════════════════════════════════════════════════════

const fullSpec = {
  openapi: '3.0.0',
  info: {
    title: 'GitHub REST API',
    description: 'GitHub REST API integration',
    version: '1.0.0',
  },
  servers: [{ url: 'https://api.github.com' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
    schemas: {
      Issue: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Issue title' },
          body: { type: 'string', description: 'Issue body' },
        },
        required: ['title'],
      },
    },
  },
  paths: {
    '/repos/{owner}/{repo}/issues': {
      get: {
        operationId: 'listIssues',
        summary: 'List issues',
        parameters: [
          { name: 'owner', in: 'path' as const, required: true, schema: { type: 'string' } },
          { name: 'repo', in: 'path' as const, required: true, schema: { type: 'string' } },
          { name: 'state', in: 'query' as const, schema: { type: 'string', enum: ['open', 'closed', 'all'] } },
        ],
        responses: { '200': { description: 'Success' } },
      },
      post: {
        operationId: 'createIssue',
        summary: 'Create an issue',
        parameters: [
          { name: 'owner', in: 'path' as const, required: true, schema: { type: 'string' } },
          { name: 'repo', in: 'path' as const, required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Issue' },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/user': {
      get: {
        operationId: 'getAuthenticatedUser',
        summary: 'Get authenticated user',
        deprecated: true,
        responses: { '200': { description: 'Success' } },
      },
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('importOpenAPISpec', () => {
  describe('with minimal spec', () => {
    it('should extract provider name and base URL', async () => {
      const result = await importOpenAPISpec(minimalSpec);
      expect(result.provider.name).toBe('Test API');
      expect(result.provider.baseUrl).toBe('https://api.test.com');
    });

    it('should generate a tool from GET operation', async () => {
      const result = await importOpenAPISpec(minimalSpec);
      expect(result.provider.tools).toHaveLength(1);

      const tool = result.provider.tools[0];
      expect(tool.id).toBe('listItems');
      expect(tool.category).toBe('read');
      expect(tool.execution.type).toBe('http');
    });

    it('should include query parameters in input schema', async () => {
      const result = await importOpenAPISpec(minimalSpec);
      const tool = result.provider.tools[0];
      const schema = tool.inputSchema;
      expect(schema.properties).toHaveProperty('page');
    });
  });

  describe('with full spec', () => {
    it('should detect bearer auth', async () => {
      const result = await importOpenAPISpec(fullSpec);
      expect(result.provider.authMethod.type).toBe('bearer_token');
    });

    it('should generate tools for non-deprecated operations', async () => {
      const result = await importOpenAPISpec(fullSpec);
      const toolIds = result.provider.tools.map((t) => t.id);
      expect(toolIds).toContain('listIssues');
      expect(toolIds).toContain('createIssue');
      expect(toolIds).not.toContain('getAuthenticatedUser');
    });

    it('should categorize POST as write', async () => {
      const result = await importOpenAPISpec(fullSpec);
      const createTool = result.provider.tools.find((t) => t.id === 'createIssue');
      expect(createTool?.category).toBe('write');
    });

    it('should resolve $ref schemas', async () => {
      const result = await importOpenAPISpec(fullSpec);
      const createTool = result.provider.tools.find((t) => t.id === 'createIssue');
      const props = createTool?.inputSchema.properties as Record<string, unknown>;
      expect(props).toHaveProperty('title');
      expect(props).toHaveProperty('body');
    });

    it('should include path parameters as required', async () => {
      const result = await importOpenAPISpec(fullSpec);
      const listTool = result.provider.tools.find((t) => t.id === 'listIssues');
      const required = listTool?.inputSchema.required as string[];
      expect(required).toContain('owner');
      expect(required).toContain('repo');
    });

    it('should warn about deprecated operations', async () => {
      const result = await importOpenAPISpec(fullSpec);
      expect(result.warnings.some((w) => w.includes('deprecated'))).toBe(true);
    });
  });

  describe('with string spec', () => {
    it('should parse JSON string', async () => {
      const result = await importOpenAPISpec(JSON.stringify(minimalSpec));
      expect(result.provider.name).toBe('Test API');
    });

    it('should parse YAML string', async () => {
      const yamlSpec = `
openapi: "3.0.0"
info:
  title: YAML API
  version: "1.0"
servers:
  - url: https://api.yaml.com
paths:
  /items:
    get:
      operationId: listItems
      summary: List items
      responses:
        "200":
          description: OK
`;
      const result = await importOpenAPISpec(yamlSpec);
      expect(result.provider.name).toBe('YAML API');
      expect(result.provider.tools).toHaveLength(1);
    });
  });

  describe('with options', () => {
    it('should filter operations by selectedOperations', async () => {
      const result = await importOpenAPISpec(fullSpec, {
        selectedOperations: ['listIssues'],
      });
      expect(result.provider.tools).toHaveLength(1);
      expect(result.provider.tools[0].id).toBe('listIssues');
    });

    it('should override base URL', async () => {
      const result = await importOpenAPISpec(minimalSpec, {
        baseUrlOverride: 'https://custom.api.com',
      });
      expect(result.provider.baseUrl).toBe('https://custom.api.com');
    });
  });

  describe('auth detection', () => {
    it('should detect API key auth', async () => {
      const spec = {
        ...minimalSpec,
        components: {
          securitySchemes: {
            apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          },
        },
      };
      const result = await importOpenAPISpec(spec);
      expect(result.provider.authMethod.type).toBe('api_key');
      if (result.provider.authMethod.type === 'api_key') {
        expect(result.provider.authMethod.config.paramName).toBe('X-API-Key');
      }
    });

    it('should detect OAuth2 auth', async () => {
      const spec = {
        ...minimalSpec,
        components: {
          securitySchemes: {
            oauth: {
              type: 'oauth2',
              flows: {
                authorizationCode: {
                  authorizationUrl: 'https://auth.example.com/authorize',
                  tokenUrl: 'https://auth.example.com/token',
                  scopes: { read: 'Read access', write: 'Write access' },
                },
              },
            },
          },
        },
      };
      const result = await importOpenAPISpec(spec);
      expect(result.provider.authMethod.type).toBe('oauth2');
      if (result.provider.authMethod.type === 'oauth2') {
        expect(result.provider.authMethod.config.scopes).toEqual(['read', 'write']);
      }
    });

    it('should default to none when no security schemes', async () => {
      const result = await importOpenAPISpec(minimalSpec);
      expect(result.provider.authMethod.type).toBe('none');
    });
  });
});
