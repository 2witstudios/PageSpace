import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createCalendarEvent,
  createTask,
  defineOperation,
  globSearch,
  listModels,
  replaceLines,
  updateTask,
  type Operation,
} from '@pagespace/sdk';
import {
  formatInvalidInputResult,
  formatSdkErrorResult,
  formatSuccessResult,
  formatUnknownToolResult,
  operationToMcpTool,
  validateToolInput,
} from '../tool-convert.js';

function jsonSchemaOf(op: Operation) {
  return operationToMcpTool(op).inputSchema as Record<string, unknown>;
}

describe('operationToMcpTool — pure registry entry -> MCP tool conversion', () => {
  it('carries the operation name and mandatory description straight through', () => {
    const tool = operationToMcpTool(globSearch);
    expect(tool.name).toBe('search.glob');
    expect(tool.description).toBe(globSearch.description);
    expect(tool.description.length).toBeGreaterThan(0);
  });

  it('produces a self-contained JSON Schema object with no external $ref/$schema noise', () => {
    const schema = jsonSchemaOf(globSearch);
    expect(schema.type).toBe('object');
    expect(schema.$schema).toBeUndefined();
    expect(JSON.stringify(schema)).not.toContain('$ref');
  });

  it('converts every property with its zod constraints (string/number/enum/bounds)', () => {
    const schema = jsonSchemaOf(globSearch) as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties.driveId).toMatchObject({ type: 'string' });
    expect(schema.properties.pattern).toMatchObject({ type: 'string', minLength: 1 });
    expect(schema.properties.maxResults).toMatchObject({ type: 'integer', minimum: 1, maximum: 200 });
  });

  it('marks non-optional fields required and drops optional fields from required', () => {
    const schema = jsonSchemaOf(globSearch) as { required: string[] };
    expect(schema.required).toContain('driveId');
    expect(schema.required).toContain('pattern');
    expect(schema.required).not.toContain('maxResults');
    expect(schema.required).not.toContain('includeTypes');
  });

  it('unwraps a top-level .refine() to the underlying object schema (replaceLines)', () => {
    const schema = jsonSchemaOf(replaceLines) as { type: string; properties: Record<string, unknown>; required: string[] };
    expect(schema.type).toBe('object');
    expect(schema.properties.startLine).toMatchObject({ type: 'integer', minimum: 1 });
    expect(schema.properties.endLine).toBeDefined();
    expect(schema.required).not.toContain('endLine');
  });

  it('unwraps a .strict().refine() object (tasks.update) the same way', () => {
    const schema = jsonSchemaOf(updateTask) as { properties: Record<string, unknown> };
    expect(schema.properties.pageId).toMatchObject({ type: 'string' });
    expect(schema.properties.title).toMatchObject({ type: 'string' });
  });

  it('converts an enum field to a JSON Schema enum of the same values', () => {
    const schema = jsonSchemaOf(createTask) as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties.priority).toMatchObject({ enum: ['low', 'medium', 'high'] });
  });

  it('converts an array-of-object field (assigneeIds union-shaped discriminator)', () => {
    const schema = jsonSchemaOf(createTask) as {
      properties: { assigneeIds: { type: string; items: { properties: Record<string, unknown> } } };
    };
    expect(schema.properties.assigneeIds.type).toBe('array');
    expect(schema.properties.assigneeIds.items.properties.type).toMatchObject({ enum: ['user', 'agent'] });
    expect(schema.properties.assigneeIds.items.properties.id).toMatchObject({ type: 'string' });
  });

  it('converts a nullable().optional() field to a nullable-compatible schema', () => {
    const schema = jsonSchemaOf(createCalendarEvent) as { properties: Record<string, unknown> };
    // description: z.string().max(10000).nullable().optional()
    const description = JSON.stringify(schema.properties.description);
    expect(description).toContain('null');
  });

  it('produces {type: "object", properties: {}} for a no-input operation', () => {
    const schema = jsonSchemaOf(listModels) as { type: string; properties: Record<string, unknown> };
    expect(schema.type).toBe('object');
    expect(schema.properties).toEqual({});
  });

  it('sets readOnlyHint true for GET operations and false otherwise', () => {
    expect(operationToMcpTool(globSearch).annotations.readOnlyHint).toBe(true);
    expect(operationToMcpTool(createTask).annotations.readOnlyHint).toBe(false);
  });

  it('sets destructiveHint from the operation\'s own destructive flag', () => {
    const destructiveOp = defineOperation({
      name: 'test.destroy',
      method: 'DELETE',
      path: '/api/test/:id',
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.object({ success: z.literal(true) }),
      destructive: true,
      description: 'Destroys a thing.',
    });
    expect(operationToMcpTool(destructiveOp).annotations.destructiveHint).toBe(true);
    expect(operationToMcpTool(globSearch).annotations.destructiveHint).toBe(false);
  });

  it('is a pure function: calling it twice on the same operation yields deep-equal, independently-frozen results', () => {
    const first = operationToMcpTool(createTask);
    const second = operationToMcpTool(createTask);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});

describe('validateToolInput — zod pre-flight before any network call', () => {
  it('accepts input matching the schema and returns parsed (defaulted) data', () => {
    const result = validateToolInput(globSearch, { driveId: 'd1', pattern: '**/*.md' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({ driveId: 'd1', pattern: '**/*.md' });
    }
  });

  it('rejects input missing a required field, without throwing', () => {
    const result = validateToolInput(globSearch, { driveId: 'd1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.join(' ')).toMatch(/pattern/);
    }
  });

  it('rejects a value that fails a numeric bound', () => {
    const result = validateToolInput(globSearch, { driveId: 'd1', pattern: '*', maxResults: 999 });
    expect(result.ok).toBe(false);
  });

  it('rejects non-object input (e.g. a bare string) without throwing', () => {
    expect(() => validateToolInput(globSearch, 'not an object')).not.toThrow();
    expect(validateToolInput(globSearch, 'not an object').ok).toBe(false);
  });

  it('rejects undefined/null input for an operation with required fields', () => {
    expect(validateToolInput(globSearch, undefined).ok).toBe(false);
    expect(validateToolInput(globSearch, null).ok).toBe(false);
  });
});

describe('formatInvalidInputResult / formatUnknownToolResult — MCP-conformant error results, never a thrown protocol error', () => {
  it('returns isError: true content mentioning the tool name and the validation issues', () => {
    const result = formatInvalidInputResult(globSearch, ['pattern: Required']);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('search.glob');
    expect(result.content[0]?.text).toContain('pattern: Required');
  });

  it('never includes a stack trace', () => {
    const result = formatInvalidInputResult(globSearch, ['pattern: Required']);
    expect(result.content[0]?.text).not.toMatch(/at .*:\d+:\d+/);
  });

  it('formatUnknownToolResult names the unrecognized tool and is an error result', () => {
    const result = formatUnknownToolResult('not_a_real_tool');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not_a_real_tool');
  });
});

describe('formatSuccessResult', () => {
  it('renders the operation output as text content, not marked as an error', () => {
    const result = formatSuccessResult({ ok: true, id: '123' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('123');
  });
});

describe('formatSdkErrorResult — distinct, secret-free messages per SDK error type', () => {
  class FakePermissionDeniedError extends Error {
    readonly code = 'PERMISSION_DENIED' as const;
  }
  class FakeAuthenticationError extends Error {
    readonly code = 'AUTHENTICATION_ERROR' as const;
  }
  class FakeNotFoundError extends Error {
    readonly code = 'NOT_FOUND' as const;
  }

  const opWithScope = defineOperation({
    name: 'test.scoped',
    method: 'POST',
    path: '/api/test',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    requiredScope: 'drive:admin',
    description: 'A scoped test operation.',
  });

  it('names the missing scope from the registry when permission is denied', () => {
    const result = formatSdkErrorResult(opWithScope, new FakePermissionDeniedError('nope'));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('drive:admin');
  });

  it('maps an authentication failure to an actionable message', () => {
    const result = formatSdkErrorResult(globSearch, new FakeAuthenticationError('nope'));
    expect(result.content[0]?.text).toMatch(/login|PAGESPACE_TOKEN/i);
  });

  it('maps a not-found error to a distinct message from permission-denied', () => {
    const notFound = formatSdkErrorResult(globSearch, new FakeNotFoundError('nope'));
    const denied = formatSdkErrorResult(opWithScope, new FakePermissionDeniedError('nope'));
    expect(notFound.content[0]?.text).not.toBe(denied.content[0]?.text);
  });

  it('never leaks a raw stack trace or the error object for an unrecognized/unexpected error', () => {
    const weird = new Error('super secret token=ps_abc123 leaked in a stack frame');
    weird.stack = 'Error: super secret token=ps_abc123\n    at leaky (/some/path.ts:42:1)';
    const result = formatSdkErrorResult(globSearch, weird);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain('ps_abc123');
    expect(result.content[0]?.text).not.toContain('at leaky');
    expect(result.content[0]?.text).not.toMatch(/at .*:\d+:\d+/);
  });

  it('never leaks anything for a thrown non-Error value', () => {
    const result = formatSdkErrorResult(globSearch, 'a plain string throw with a token ps_zzz');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain('ps_zzz');
  });
});
