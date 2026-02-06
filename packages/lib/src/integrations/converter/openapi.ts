/**
 * OpenAPI Importer
 *
 * Parses OpenAPI 3.x specifications and generates IntegrationProviderConfig
 * with tool definitions derived from API operations.
 */

import { parse as parseYaml } from 'yaml';
import type {
  IntegrationProviderConfig,
  ToolDefinition,
  AuthMethod,
  HttpMethod,
  HttpExecutionConfig,
  ToolCategory,
} from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ImportOptions {
  selectedOperations?: string[];
  baseUrlOverride?: string;
}

export interface ImportResult {
  provider: IntegrationProviderConfig;
  warnings: string[];
}

interface OpenAPISpec {
  openapi?: string;
  info?: {
    title?: string;
    description?: string;
    version?: string;
  };
  servers?: Array<{ url?: string; description?: string }>;
  paths?: Record<string, Record<string, OpenAPIOperation>>;
  components?: {
    securitySchemes?: Record<string, OpenAPISecurityScheme>;
    schemas?: Record<string, Record<string, unknown>>;
  };
  security?: Array<Record<string, string[]>>;
}

interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenAPIParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
  responses?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  deprecated?: boolean;
}

interface OpenAPIParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

interface OpenAPISecurityScheme {
  type: string;
  scheme?: string;
  in?: string;
  name?: string;
  flows?: Record<string, {
    authorizationUrl?: string;
    tokenUrl?: string;
    scopes?: Record<string, string>;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN IMPORTER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Import an OpenAPI 3.x spec and generate an IntegrationProviderConfig.
 *
 * @param spec - JSON/YAML string or parsed object
 * @param options - Optional import configuration
 */
export async function importOpenAPISpec(
  spec: string | object,
  options?: ImportOptions
): Promise<ImportResult> {
  const warnings: string[] = [];

  // Parse spec if string
  const parsed = typeof spec === 'string' ? parseSpec(spec) : (spec as OpenAPISpec);

  if (!parsed.openapi?.startsWith('3.')) {
    warnings.push(`Spec version "${parsed.openapi}" may not be fully supported. OpenAPI 3.x is recommended.`);
  }

  // Extract base info
  const title = parsed.info?.title || 'Untitled API';
  const description = parsed.info?.description;
  const baseUrl = options?.baseUrlOverride || parsed.servers?.[0]?.url || 'https://api.example.com';

  // Detect auth method
  const authMethod = detectAuthMethod(parsed, warnings);

  // Build tools from operations
  const tools: ToolDefinition[] = [];

  if (parsed.paths) {
    for (const [path, methods] of Object.entries(parsed.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        // Skip non-HTTP methods (parameters, etc.)
        if (!isHttpMethod(method)) continue;

        // Skip deprecated operations
        if (operation.deprecated) {
          warnings.push(`Skipping deprecated operation: ${method.toUpperCase()} ${path}`);
          continue;
        }

        // Apply operation filter
        const operationId = operation.operationId || `${method}_${path.replace(/[{}\/]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')}`;

        if (options?.selectedOperations && !options.selectedOperations.includes(operationId)) {
          continue;
        }

        try {
          const tool = buildToolFromOperation(
            path,
            method.toUpperCase() as HttpMethod,
            operation,
            operationId,
            parsed.components?.schemas
          );
          tools.push(tool);
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          warnings.push(`Failed to import ${method.toUpperCase()} ${path}: ${msg}`);
        }
      }
    }
  }

  if (tools.length === 0) {
    warnings.push('No operations were imported from the spec.');
  }

  // Generate slug from title
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);

  const provider: IntegrationProviderConfig = {
    id: `openapi-${slug}`,
    name: title,
    description: description || undefined,
    authMethod,
    baseUrl: normalizeBaseUrl(baseUrl),
    tools,
  };

  return { provider, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function parseSpec(spec: string): OpenAPISpec {
  const trimmed = spec.trim();

  // Try JSON first (faster, more common)
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }

  // Try YAML
  return parseYaml(trimmed);
}

function isHttpMethod(method: string): boolean {
  return ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method.toLowerCase());
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

function inferCategory(method: HttpMethod): ToolCategory {
  switch (method) {
    case 'GET':
      return 'read';
    case 'DELETE':
      return 'admin';
    case 'POST':
    case 'PUT':
    case 'PATCH':
      return 'write';
    default:
      return 'read';
  }
}

function detectAuthMethod(spec: OpenAPISpec, warnings: string[]): AuthMethod {
  const schemes = spec.components?.securitySchemes;
  if (!schemes) return { type: 'none' };

  // Use the first security scheme defined
  for (const [name, scheme] of Object.entries(schemes)) {
    switch (scheme.type) {
      case 'oauth2': {
        const flow = scheme.flows?.authorizationCode || scheme.flows?.clientCredentials;
        if (flow) {
          const scopes = flow.scopes ? Object.keys(flow.scopes) : [];
          return {
            type: 'oauth2',
            config: {
              authorizationUrl: flow.authorizationUrl || '',
              tokenUrl: flow.tokenUrl || '',
              scopes,
            },
          };
        }
        warnings.push(`OAuth2 scheme "${name}" has no supported flow.`);
        break;
      }

      case 'http':
        if (scheme.scheme === 'bearer') {
          return {
            type: 'bearer_token',
            config: {},
          };
        }
        if (scheme.scheme === 'basic') {
          return {
            type: 'basic_auth',
            config: {
              usernameField: 'username',
              passwordField: 'password',
            },
          };
        }
        break;

      case 'apiKey':
        return {
          type: 'api_key',
          config: {
            placement: (scheme.in === 'query' ? 'query' : 'header') as 'header' | 'query',
            paramName: scheme.name || 'api_key',
          },
        };

      default:
        warnings.push(`Unsupported security scheme type "${scheme.type}" for "${name}".`);
    }
  }

  return { type: 'none' };
}

function buildToolFromOperation(
  path: string,
  method: HttpMethod,
  operation: OpenAPIOperation,
  operationId: string,
  schemas?: Record<string, Record<string, unknown>>
): ToolDefinition {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  // Add path and query parameters to input schema
  if (operation.parameters) {
    for (const param of operation.parameters) {
      if (param.in === 'path' || param.in === 'query') {
        properties[param.name] = {
          ...resolveSchema(param.schema || { type: 'string' }, schemas),
          description: param.description,
        };
        if (param.required || param.in === 'path') {
          required.push(param.name);
        }
      }
    }
  }

  // Add request body to input schema
  if (operation.requestBody?.content) {
    const jsonContent = operation.requestBody.content['application/json'];
    if (jsonContent?.schema) {
      const bodySchema = resolveSchema(jsonContent.schema, schemas);
      if (bodySchema.properties) {
        const bodyProps = bodySchema.properties as Record<string, Record<string, unknown>>;
        for (const [propName, propSchema] of Object.entries(bodyProps)) {
          properties[propName] = propSchema;
        }
        if (bodySchema.required && Array.isArray(bodySchema.required)) {
          required.push(...(bodySchema.required as string[]));
        }
      } else {
        // Wrap entire body schema as a single 'body' parameter
        properties['body'] = bodySchema;
        if (operation.requestBody.required) {
          required.push('body');
        }
      }
    }
  }

  const inputSchema: Record<string, unknown> = {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };

  // Build query params map from query parameters using ParameterRef
  const queryParams: Record<string, { $param: string }> = {};
  if (operation.parameters) {
    for (const param of operation.parameters) {
      if (param.in === 'query') {
        queryParams[param.name] = { $param: param.name };
      }
    }
  }

  const executionConfig: HttpExecutionConfig = {
    method,
    pathTemplate: path,
    ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
  };

  // Add body template for methods that support request bodies
  if (['POST', 'PUT', 'PATCH'].includes(method) && operation.requestBody?.content) {
    const jsonContent = operation.requestBody.content['application/json'];
    if (jsonContent?.schema) {
      const bodySchema = resolveSchema(jsonContent.schema, schemas);
      if (bodySchema.properties) {
        const bodyTemplate: Record<string, unknown> = {};
        for (const propName of Object.keys(bodySchema.properties as Record<string, unknown>)) {
          bodyTemplate[propName] = { $param: propName };
        }
        executionConfig.bodyTemplate = bodyTemplate;
        executionConfig.bodyEncoding = 'json';
      } else {
        // Non-object body (array, primitive) — reference the 'body' input param
        executionConfig.bodyTemplate = { $param: 'body' };
        executionConfig.bodyEncoding = 'json';
      }
    }
  }

  return {
    id: operationId,
    name: operation.summary || operationId,
    description: operation.description || operation.summary || `${method} ${path}`,
    category: inferCategory(method),
    inputSchema,
    execution: {
      type: 'http',
      config: executionConfig,
    },
  };
}

/**
 * Resolve a schema, following $ref if present.
 * Only handles simple top-level $ref (no deep nesting).
 */
function resolveSchema(
  schema: Record<string, unknown>,
  schemas?: Record<string, Record<string, unknown>>
): Record<string, unknown> {
  if (schema.$ref && typeof schema.$ref === 'string' && schemas) {
    const refPath = schema.$ref.replace('#/components/schemas/', '');
    const resolved = schemas[refPath];
    if (resolved) return resolved;
  }
  return schema;
}
