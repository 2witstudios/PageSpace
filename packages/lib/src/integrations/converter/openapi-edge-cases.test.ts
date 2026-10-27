import { describe, test, expect } from 'vitest';
import { importOpenAPISpec } from './openapi';

describe('OpenAPI importer boundary cases', () => {
  test.each([
    [{ type: 'http', scheme: 'basic' }, { type: 'basic_auth', config: { usernameField: 'username', passwordField: 'password' } }],
    [{ type: 'apiKey', in: 'query' }, { type: 'api_key', config: { placement: 'query', paramName: 'api_key' } }],
    [{ type: 'apiKey', in: 'cookie', name: 'token' }, { type: 'api_key', config: { placement: 'header', paramName: 'token' } }],
    [{ type: 'oauth2', flows: { clientCredentials: {} } }, { type: 'oauth2', config: { authorizationUrl: '', tokenUrl: '', scopes: [] } }],
  ])('preserves supported authentication configuration %#', async (scheme, expected) => {
    const result = await importOpenAPISpec({ openapi: '3.1.0', components: { securitySchemes: { auth: scheme } } });
    expect(result.provider.authMethod).toEqual(expected);
  });

  test('warns on unsupported auth and continues to a usable scheme', async () => {
    const result = await importOpenAPISpec({
      components: { securitySchemes: {
        oauth: { type: 'oauth2' },
        digest: { type: 'http', scheme: 'digest' },
        custom: { type: 'custom' },
        bearer: { type: 'http', scheme: 'bearer' },
      } },
    });
    expect(result.provider.authMethod).toEqual({ type: 'bearer_token', config: {} });
    expect(result.warnings).toEqual([
      'Spec version "undefined" may not be fully supported. OpenAPI 3.x is recommended.',
      'OAuth2 scheme "oauth" has no supported flow.',
      'Unsupported security scheme type "custom" for "custom".',
      'No operations were imported from the spec.',
    ]);
    expect(result.provider).toMatchObject({ name: 'Untitled API', baseUrl: 'https://api.example.com' });
  });

  test('returns anonymous auth when all schemes are unsupported', async () => {
    const result = await importOpenAPISpec({ openapi: '3.0.0', components: { securitySchemes: { oauth: { type: 'oauth2', flows: { implicit: {} } } } } });
    expect(result.provider.authMethod).toEqual({ type: 'none' });
    expect(result.warnings[0]).toContain('no supported flow');
  });

  test('imports optional array bodies and ignores non-JSON bodies and header parameters', async () => {
    const result = await importOpenAPISpec({ openapi: '3.0.0', paths: {
      '/array': { patch: { requestBody: { content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } } } },
      '/form': { put: { parameters: [{ name: 'secret', in: 'header' }, { name: 'q', in: 'query' }], requestBody: { content: { 'text/plain': {} } } } },
      '/head': { head: {} },
      '/options': { options: {} },
    } });
    expect(result.provider.tools).toHaveLength(4);
    const [array, form, head, options] = result.provider.tools;
    expect(array.inputSchema).toEqual({ type: 'object', properties: { body: { type: 'array', items: { type: 'string' } } }, required: undefined });
    expect(array.execution).toMatchObject({ config: { bodyTemplate: { $param: 'body' }, bodyEncoding: 'json' } });
    expect(form.inputSchema.properties).toEqual({ q: { type: 'string', description: undefined } });
    expect(form.execution).toEqual({ type: 'http', config: { method: 'PUT', pathTemplate: '/form', queryParams: { q: { $param: 'q' } } } });
    expect(head.category).toBe('read');
    expect(options.category).toBe('read');
  });

  test('preserves unresolved references and imports the remaining operations after malformed input', async () => {
    const result = await importOpenAPISpec({ openapi: '3.0.0', components: { schemas: {} }, paths: {
      '/missing': { get: { parameters: [{ name: 'q', in: 'query', schema: { $ref: '#/components/schemas/Missing' } }] } },
      '/broken': { get: { parameters: [null] } },
      '/valid': { delete: {} },
    } });
    expect(result.provider.tools.map(tool => tool.id)).toEqual(['get_missing', 'delete_valid']);
    expect(result.provider.tools[0].inputSchema.properties).toEqual({ q: { $ref: '#/components/schemas/Missing', description: undefined } });
    expect(result.provider.tools[1].category).toBe('admin');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Failed to import GET /broken:');
  });
});
