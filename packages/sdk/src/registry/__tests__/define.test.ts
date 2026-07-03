import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import type { Operation, PathParamNames, RequiredScope } from '../define.js';

describe('PathParamNames — type-level path param extraction', () => {
  it('extracts a single param', () => {
    expectTypeOf<PathParamNames<'/api/drives/:driveId'>>().toEqualTypeOf<'driveId'>();
  });

  it('extracts multiple params', () => {
    expectTypeOf<PathParamNames<'/api/drives/:driveId/pages/:pageId'>>().toEqualTypeOf<'driveId' | 'pageId'>();
  });

  it('is never for a path with no params', () => {
    expectTypeOf<PathParamNames<'/api/drives'>>().toEqualTypeOf<never>();
  });
});

describe('defineOperation — runtime shape', () => {
  it('captures every field verbatim', () => {
    const inputSchema = z.object({ driveId: z.string() });
    const outputSchema = z.object({ ok: z.boolean() });
    const op = defineOperation({
      name: 'test.op',
      method: 'GET',
      path: '/api/drives/:driveId',
      inputSchema,
      outputSchema,
      requiredScope: 'drive',
      description: 'A test operation.',
    });

    expect(op.name).toBe('test.op');
    expect(op.method).toBe('GET');
    expect(op.path).toBe('/api/drives/:driveId');
    expect(op.inputSchema).toBe(inputSchema);
    expect(op.outputSchema).toBe(outputSchema);
    expect(op.requiredScope).toBe('drive');
    expect(op.description).toBe('A test operation.');
    expect(op.textResponse).toBeUndefined();
  });

  it('requiredScope and textResponse are optional', () => {
    const op = defineOperation({
      name: 'test.noscope',
      method: 'GET',
      path: '/api/widgets',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      description: 'No scope needed.',
    });

    expect(op.requiredScope).toBeUndefined();
    expect(op.textResponse).toBeUndefined();
  });

  it('captures an explicit timeoutMsOverride, defaulting to undefined otherwise (facade override, Phase 3 task 5 agents.ask)', () => {
    const slow = defineOperation({
      name: 'test.slow',
      method: 'POST',
      path: '/api/widgets/slow',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      timeoutMsOverride: 120_000,
      description: 'A long-running op.',
    });
    expect(slow.timeoutMsOverride).toBe(120_000);

    const fast = defineOperation({
      name: 'test.fast',
      method: 'GET',
      path: '/api/widgets',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      description: 'A regular op.',
    });
    expect(fast.timeoutMsOverride).toBeUndefined();
  });

  it('captures an explicit expectedContentType, defaulting to undefined otherwise (Phase 3 task 10 export ops)', () => {
    const exportOp = defineOperation({
      name: 'test.export',
      method: 'GET',
      path: '/api/widgets/export',
      inputSchema: z.object({}),
      outputSchema: z.string(),
      textResponse: true,
      expectedContentType: 'text/csv',
      description: 'A text-export op.',
    });
    expect(exportOp.expectedContentType).toBe('text/csv');

    const jsonOp = defineOperation({
      name: 'test.json',
      method: 'GET',
      path: '/api/widgets',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      description: 'A regular op.',
    });
    expect(jsonOp.expectedContentType).toBeUndefined();
  });
});

describe('defineOperation — static type inference', () => {
  it('preserves the path as a literal type', () => {
    const op = defineOperation({
      name: 'test.op',
      method: 'GET',
      path: '/api/drives/:driveId',
      inputSchema: z.object({ driveId: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      description: 'A test operation.',
    });

    expectTypeOf(op.path).toEqualTypeOf<'/api/drives/:driveId'>();
  });

  it('infers input/output types from the zod schemas', () => {
    const op = defineOperation({
      name: 'test.op',
      method: 'POST',
      path: '/api/widgets',
      inputSchema: z.object({ title: z.string() }),
      outputSchema: z.object({ id: z.string(), title: z.string() }),
      description: 'A test operation.',
    });

    type Input = z.infer<typeof op.inputSchema>;
    type Output = z.infer<typeof op.outputSchema>;
    expectTypeOf<Input>().toEqualTypeOf<{ title: string }>();
    expectTypeOf<Output>().toEqualTypeOf<{ id: string; title: string }>();
  });

  it('narrows requiredScope to the ADR 0002 grammar union, not a free string', () => {
    expectTypeOf<RequiredScope>().toEqualTypeOf<'account' | 'drive' | 'drive:admin' | 'drive:member'>();
  });

  it('rejects an inputSchema missing a path param at compile time', () => {
    // @ts-expect-error inputSchema has no `driveId` field to satisfy the `:driveId` path param.
    defineOperation({
      name: 'test.missing-param',
      method: 'GET',
      path: '/api/drives/:driveId',
      inputSchema: z.object({ unrelated: z.string() }),
      outputSchema: z.object({}),
      description: 'Should not compile.',
    });
  });

  it('accepts an inputSchema covering all path params plus extra fields', () => {
    const op = defineOperation({
      name: 'test.covers-params',
      method: 'GET',
      path: '/api/drives/:driveId/pages/:pageId',
      inputSchema: z.object({ driveId: z.string(), pageId: z.string(), recursive: z.boolean().optional() }),
      outputSchema: z.object({}),
      description: 'Covers both params plus an extra query field.',
    });

    expectTypeOf(op).toMatchTypeOf<Operation>();
  });
});
