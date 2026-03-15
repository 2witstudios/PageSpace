import { describe, it, expect } from 'vitest';

import {
  zodToJsonSchema,
  extractToolSchemas,
  formatSchemaForDisplay,
  calculateTotalToolTokens,
} from '../schema-introspection';

import type { JsonSchema, ToolSchemaInfo } from '../schema-introspection';

describe('schema-introspection', () => {
  describe('zodToJsonSchema', () => {
    it('should return empty schema for null/undefined input', () => {
      // @ts-expect-error testing null input
      const result = zodToJsonSchema(null);
      expect(result).toEqual({ type: 'object', properties: {}, required: [] });
    });

    it('should process a schema with shape property', () => {
      const mockSchema = {
        shape: {
          name: {
            _def: { typeName: 'ZodString' },
          },
          age: {
            _def: { typeName: 'ZodNumber' },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties).toHaveProperty('name');
      expect(result.properties).toHaveProperty('age');
      expect(result.properties.name.type).toBe('string');
      expect(result.properties.age.type).toBe('number');
    });

    it('should process a schema with _def.shape property', () => {
      const mockSchema = {
        _def: {
          shape: {
            title: {
              _def: { typeName: 'ZodString' },
            },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties).toHaveProperty('title');
      expect(result.properties.title.type).toBe('string');
    });

    it('should process a schema with _zod.def.shape property', () => {
      const mockSchema = {
        _zod: {
          def: {
            shape: {
              value: {
                _def: { typeName: 'ZodBoolean' },
              },
            },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties).toHaveProperty('value');
      expect(result.properties.value.type).toBe('boolean');
    });

    it('should mark required fields when not optional', () => {
      const mockSchema = {
        shape: {
          required_field: {
            _def: { typeName: 'ZodString' },
          },
          optional_field: {
            _def: { typeName: 'ZodOptional', innerType: { _def: { typeName: 'ZodString' } } },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.required).toContain('required_field');
      expect(result.required).not.toContain('optional_field');
    });

    it('should handle ZodOptional wrapping', () => {
      const mockSchema = {
        shape: {
          optField: {
            _def: {
              typeName: 'ZodOptional',
              innerType: { _def: { typeName: 'ZodString' } },
            },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties.optField.optional).toBe(true);
      expect(result.properties.optField.type).toBe('string');
    });

    it('should handle ZodEnum type', () => {
      const mockSchema = {
        shape: {
          status: {
            _def: {
              typeName: 'ZodEnum',
              values: ['active', 'inactive', 'pending'],
            },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties.status.type).toBe('string');
      expect(result.properties.status.enum).toEqual(['active', 'inactive', 'pending']);
    });

    it('should handle ZodEnum with object values', () => {
      const mockSchema = {
        shape: {
          status: {
            _def: {
              typeName: 'ZodEnum',
              values: { ACTIVE: 'active', INACTIVE: 'inactive' },
            },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties.status.enum).toEqual(['active', 'inactive']);
    });

    it('should handle ZodArray type', () => {
      const mockSchema = {
        shape: {
          items: {
            _def: {
              typeName: 'ZodArray',
              type: { _def: { typeName: 'ZodString' } },
            },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties.items.type).toBe('array');
      expect(result.properties.items.items?.type).toBe('string');
    });

    it('should handle ZodObject nested type', () => {
      const mockSchema = {
        shape: {
          nested: {
            _def: {
              typeName: 'ZodObject',
              shape: {
                inner: { _def: { typeName: 'ZodString' } },
              },
            },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties.nested.type).toBe('object');
      expect(result.properties.nested.properties).toHaveProperty('inner');
    });

    it('should handle ZodLiteral type', () => {
      const mockSchema = {
        shape: {
          literal: {
            _def: {
              typeName: 'ZodLiteral',
              value: 'hello',
            },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties.literal.type).toBe('string');
      expect(result.properties.literal.enum).toEqual(['hello']);
    });

    it('should handle ZodUnion with all literals', () => {
      const mockSchema = {
        shape: {
          union: {
            _def: {
              typeName: 'ZodUnion',
              options: [
                { _def: { typeName: 'ZodLiteral', value: 'a' } },
                { _def: { typeName: 'ZodLiteral', value: 'b' } },
              ],
            },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties.union.type).toBe('string');
      expect(result.properties.union.enum).toEqual(['a', 'b']);
    });

    it('should handle ZodUnion with mixed types', () => {
      const mockSchema = {
        shape: {
          union: {
            _def: {
              typeName: 'ZodUnion',
              options: [
                { _def: { typeName: 'ZodString' } },
                { _def: { typeName: 'ZodNumber' } },
              ],
            },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties.union.type).toBe('union');
    });

    it('should handle ZodRecord type', () => {
      const mockSchema = {
        shape: {
          record: {
            _def: { typeName: 'ZodRecord' },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties.record.type).toBe('object');
    });

    it('should handle ZodAny type', () => {
      const mockSchema = {
        shape: {
          anything: {
            _def: { typeName: 'ZodAny' },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties.anything.type).toBe('any');
    });

    it('should include description from _def.description', () => {
      const mockSchema = {
        shape: {
          field: {
            _def: {
              typeName: 'ZodString',
              description: 'A description',
            },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties.field.description).toBe('A description');
    });

    it('should handle ZodDefault and extract default value', () => {
      const mockSchema = {
        shape: {
          field: {
            _def: {
              typeName: 'ZodDefault',
              defaultValue: () => 'default-value',
              innerType: { _def: { typeName: 'ZodString' } },
            },
          },
        },
      };

      const result = zodToJsonSchema(mockSchema);
      expect(result.properties.field.optional).toBe(true);
      expect(result.properties.field.default).toBe('default-value');
    });

    it('should handle schema with no shape', () => {
      const result = zodToJsonSchema({});
      expect(result).toEqual({ type: 'object', properties: {}, required: [] });
    });
  });

  describe('extractToolSchemas', () => {
    it('should extract schema info from tool definitions', () => {
      const tools = {
        my_tool: {
          description: 'A test tool',
          parameters: {
            shape: {
              name: { _def: { typeName: 'ZodString' } },
            },
          },
        },
      };

      const result = extractToolSchemas(tools);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('my_tool');
      expect(result[0].description).toBe('A test tool');
      expect(result[0].parameters.properties).toHaveProperty('name');
    });

    it('should handle tools without parameters', () => {
      const tools = {
        no_params_tool: {
          description: 'No params',
        },
      };

      const result = extractToolSchemas(tools);
      expect(result).toHaveLength(1);
      expect(result[0].parameters).toEqual({ type: 'object', properties: {}, required: [] });
    });

    it('should handle tools without description', () => {
      const tools = {
        no_desc_tool: {},
      };

      const result = extractToolSchemas(tools);
      expect(result[0].description).toBe('');
    });

    it('should estimate token count for each tool', () => {
      const tools = {
        tool_with_desc: {
          description: 'A description',
        },
      };

      const result = extractToolSchemas(tools);
      expect(result[0].tokenEstimate).toBeGreaterThan(0);
    });

    it('should return empty array for empty tools', () => {
      const result = extractToolSchemas({});
      expect(result).toHaveLength(0);
    });

    it('should process multiple tools', () => {
      const tools = {
        tool_a: { description: 'Tool A' },
        tool_b: { description: 'Tool B' },
        tool_c: { description: 'Tool C' },
      };

      const result = extractToolSchemas(tools);
      expect(result).toHaveLength(3);
      const names = result.map(t => t.name);
      expect(names).toContain('tool_a');
      expect(names).toContain('tool_b');
      expect(names).toContain('tool_c');
    });
  });

  describe('formatSchemaForDisplay', () => {
    it('should return pretty-printed JSON', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      };

      const result = formatSchemaForDisplay(schema);
      expect(result).toContain('\n');
      expect(result).toContain('"type": "object"');
      expect(result).toContain('"name"');
    });

    it('should be valid JSON', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {},
        required: [],
      };

      const result = formatSchemaForDisplay(schema);
      expect(() => JSON.parse(result)).not.toThrow();
    });
  });

  describe('calculateTotalToolTokens', () => {
    it('should sum all token estimates', () => {
      const schemas: ToolSchemaInfo[] = [
        { name: 'a', description: 'A', parameters: { type: 'object', properties: {}, required: [] }, tokenEstimate: 10 },
        { name: 'b', description: 'B', parameters: { type: 'object', properties: {}, required: [] }, tokenEstimate: 20 },
        { name: 'c', description: 'C', parameters: { type: 'object', properties: {}, required: [] }, tokenEstimate: 30 },
      ];

      expect(calculateTotalToolTokens(schemas)).toBe(60);
    });

    it('should return 0 for empty array', () => {
      expect(calculateTotalToolTokens([])).toBe(0);
    });

    it('should handle single tool', () => {
      const schemas: ToolSchemaInfo[] = [
        { name: 'a', description: 'A', parameters: { type: 'object', properties: {}, required: [] }, tokenEstimate: 42 },
      ];

      expect(calculateTotalToolTokens(schemas)).toBe(42);
    });
  });
});
