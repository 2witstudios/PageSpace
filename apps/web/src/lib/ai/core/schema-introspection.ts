/**
 * Zod Schema Introspection Utility
 *
 * Converts Zod schemas to JSON Schema format for display in the admin UI.
 * This allows viewing the full tool parameter definitions as the AI sees them.
 *
 * Compatible with Zod v4.
 */

export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
  optional?: boolean;
}

export interface JsonSchema {
  type: string;
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  description?: string;
}

export interface ToolSchemaInfo {
  name: string;
  description: string;
  parameters: JsonSchema;
  tokenEstimate: number;
}

/**
 * Convert a Zod schema to JSON Schema format using its internal structure
 * Works with Zod v4's _zod property
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function zodToJsonSchema(schema: any): JsonSchema {
  const result: JsonSchema = {
    type: 'object',
    properties: {},
    required: [],
  };

  if (!schema) {
    return result;
  }

  // Try to access the shape for ZodObject
  // Zod v4 uses different internal structure
  const shape = schema.shape || schema._def?.shape || schema._zod?.def?.shape;

  if (shape) {
    for (const [key, value] of Object.entries(shape)) {
      const propertySchema = zodTypeToJsonSchema(value);
      result.properties[key] = propertySchema;

      // Check if required (not optional)
      if (!isOptional(value)) {
        result.required.push(key);
      }
    }
  }

  return result;
}

/**
 * Check if a Zod type is optional
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isOptional(schema: any): boolean {
  if (!schema) return true;

  // Check various ways Zod marks optionality
  const typeName = getZodTypeName(schema);

  if (typeName === 'ZodOptional' || typeName === 'ZodNullable' || typeName === 'ZodDefault') {
    return true;
  }

  // Check _def for optionality markers
  if (schema._def?.typeName === 'ZodOptional' ||
      schema._def?.typeName === 'ZodNullable' ||
      schema._def?.typeName === 'ZodDefault') {
    return true;
  }

  // Check if marked optional via isOptional()
  if (schema.isOptional?.()) {
    return true;
  }

  return false;
}

/**
 * Get the Zod type name from a schema
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getZodTypeName(schema: any): string {
  if (!schema) return 'unknown';

  // Try different ways to get the type name
  return schema._def?.typeName ||
         schema._zod?.def?.typeName ||
         schema.constructor?.name ||
         'unknown';
}

/**
 * Get the inner type from an optional/nullable wrapper
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapType(schema: any): any {
  if (!schema) return schema;

  const typeName = getZodTypeName(schema);

  if (typeName === 'ZodOptional' || typeName === 'ZodNullable' || typeName === 'ZodDefault') {
    const innerType = schema._def?.innerType || schema._zod?.def?.innerType;
    return innerType ? unwrapType(innerType) : schema;
  }

  return schema;
}

/**
 * Convert a single Zod type to JSON Schema property
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function zodTypeToJsonSchema(schema: any): JsonSchemaProperty {
  const isOpt = isOptional(schema);
  const unwrapped = unwrapType(schema);
  const typeName = getZodTypeName(unwrapped);

  // Get description if available
  const description = unwrapped?._def?.description || unwrapped?.description;

  let result: JsonSchemaProperty;

  switch (typeName) {
    case 'ZodString':
      result = { type: 'string' };
      break;

    case 'ZodNumber':
      result = { type: 'number' };
      break;

    case 'ZodBoolean':
      result = { type: 'boolean' };
      break;

    case 'ZodArray': {
      const itemType = unwrapped._def?.type || unwrapped._zod?.def?.type;
      result = {
        type: 'array',
        items: itemType ? zodTypeToJsonSchema(itemType) : { type: 'unknown' },
      };
      break;
    }

    case 'ZodObject': {
      const nestedSchema = zodToJsonSchema(unwrapped);
      result = {
        type: 'object',
        properties: nestedSchema.properties,
        required: nestedSchema.required,
      };
      break;
    }

    case 'ZodEnum': {
      const values = unwrapped._def?.values || unwrapped._zod?.def?.values || [];
      result = {
        type: 'string',
        enum: Array.isArray(values) ? values : Object.values(values),
      };
      break;
    }

    case 'ZodLiteral': {
      const value = unwrapped._def?.value ?? unwrapped._def?.values?.[0] ?? unwrapped._zod?.def?.value;
      result = {
        type: typeof value as string,
        enum: [String(value)],
      };
      break;
    }

    case 'ZodUnion': {
      const options = unwrapped._def?.options || unwrapped._zod?.def?.options || [];
      // For unions, try to represent as enum if all literals
      const allLiterals = options.every((opt: unknown) => getZodTypeName(opt) === 'ZodLiteral');
      if (allLiterals && options.length > 0) {
        result = {
          type: 'string',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          enum: options.map((opt: any) => String(opt._def?.value ?? opt._def?.values?.[0] ?? '')),
        };
      } else {
        result = { type: 'union' };
      }
      break;
    }

    case 'ZodRecord':
      result = { type: 'object' };
      break;

    case 'ZodAny':
      result = { type: 'any' };
      break;

    default:
      result = { type: typeName.replace('Zod', '').toLowerCase() || 'unknown' };
  }

  // Add description and optional flag
  if (description) {
    result.description = description;
  }
  if (isOpt) {
    result.optional = true;
  }

  // Check for default value
  if (getZodTypeName(schema) === 'ZodDefault') {
    try {
      const defaultFn = schema._def?.defaultValue;
      if (typeof defaultFn === 'function') {
        result.default = defaultFn();
      }
    } catch {
      // Ignore errors getting default value
    }
  }

  return result;
}

/**
 * Extract tool schemas from PageSpace tools
 */
export function extractToolSchemas(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, { description?: string; parameters?: any }>
): ToolSchemaInfo[] {
  return Object.entries(tools).map(([name, tool]) => {
    const parameters = tool.parameters
      ? zodToJsonSchema(tool.parameters)
      : { type: 'object', properties: {}, required: [] };

    const description = tool.description || '';

    // Estimate tokens for this tool definition
    // Rough estimate: name + description + JSON schema
    const schemaJson = JSON.stringify(parameters);
    const tokenEstimate = Math.ceil((name.length + description.length + schemaJson.length) / 4);

    return {
      name,
      description,
      parameters,
      tokenEstimate,
    };
  });
}

/**
 * Calculate total token estimate for all tool schemas
 */
export function calculateTotalToolTokens(schemas: ToolSchemaInfo[]): number {
  return schemas.reduce((sum, schema) => sum + schema.tokenEstimate, 0);
}
