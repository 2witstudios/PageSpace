import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';
import { buildRealtimeTools, toRealtimeTool } from '../tools';
import { CORE_TOOL_NAMES } from '../../core/stub-tools';
import { createToolSearchTool } from '../../tools/tool-search-tool';
import { createExecuteTool } from '../../tools/execute-tool';
// The REAL registry, unmocked on purpose — see the regression-guard case below.
import { buildPageSpaceTools } from '../../core/ai-tools';

const fakeTool = (over: Partial<Tool> = {}): Tool =>
  ({
    description: 'A tool.',
    inputSchema: z.object({ pageId: z.string() }),
    execute: async () => ({}),
    ...over,
  }) as Tool;

/** A set with one core tool and one deferrable tool. */
const smallSet = (): ToolSet => ({
  read_page: fakeTool({ description: 'Read a page.' }),
  rename_drive: fakeTool({ description: 'Rename a drive.' }),
});

const names = (tools: readonly { name: string }[]) => tools.map((t) => t.name);

/** Every key anywhere in a JSON value, at any depth. */
function deepKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(deepKeys);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    k,
    ...deepKeys(v),
  ]);
}

describe('buildRealtimeTools', () => {
  it('given the full PageSpace ToolSet, should emit exactly the core tools plus the two scaffolding tools', () => {
    const registry = buildPageSpaceTools({ codeExecutionEnabled: true });
    const emitted = names(buildRealtimeTools(registry));
    const registryCoreNames = Object.keys(registry).filter((n) => CORE_TOOL_NAMES.has(n));

    expect(new Set(emitted)).toEqual(
      new Set([...registryCoreNames, 'tool_search', 'execute_tool']),
    );
    // No duplicates: the scaffolding must not collide with a registry name.
    expect(emitted.length).toBe(registryCoreNames.length + 2);

    // `registryCoreNames` is CORE_TOOL_NAMES minus any name with no tool behind
    // it, which is why it — not CORE_TOOL_NAMES itself — is the expectation.
    // Today `get_page_details` is such a name: it is listed in stub-tools.ts but
    // defined by no tool module, so nothing can be emitted for it. Splitting a
    // set of names against a set of tools can only ever yield tools that exist.
    expect([...CORE_TOOL_NAMES].filter((n) => !registryCoreNames.includes(n))).toEqual([
      'get_page_details',
    ]);
  });

  it('given the full PageSpace ToolSet, should defer every non-core tool rather than front-loading it', () => {
    const registry = buildPageSpaceTools({ codeExecutionEnabled: true });
    const emitted = new Set(names(buildRealtimeTools(registry)));
    const nonCore = Object.keys(registry).filter((n) => !CORE_TOOL_NAMES.has(n));

    // The registry is big enough for deferral to be the point of the split.
    expect(nonCore.length).toBeGreaterThan(CORE_TOOL_NAMES.size);
    for (const name of nonCore) {
      expect(emitted.has(name)).toBe(false);
    }
  });

  it('given EVERY tool in the real registry, should convert without throwing', () => {
    // The regression guard: a `z.date()`/`z.bigint()`/`z.map()`/transform added to
    // any tool input is unrepresentable in JSON Schema and makes z.toJSONSchema
    // throw. This case fails the moment that lands, in whichever module it lands.
    //
    // It drives `toRealtimeTool` directly, NOT buildRealtimeTools: the latter
    // converts only the upfront half, so a deferred tool — which is most of the
    // registry — would never have its schema touched and the guard would pass
    // vacuously. (Mutation-checked: adding `z.date()` to a deferred tool goes red
    // here and stays green through buildRealtimeTools.)
    const registry = buildPageSpaceTools({ codeExecutionEnabled: true });
    expect(Object.keys(registry).length).toBeGreaterThan(50);

    for (const [name, tool] of Object.entries(registry)) {
      expect(
        () => toRealtimeTool(name, tool),
        `tool "${name}" is not representable as realtime parameters`,
      ).not.toThrow();
    }
    expect(() => buildRealtimeTools(registry)).not.toThrow();
  });

  it('given an unrepresentable input schema, should throw rather than emit a lie', () => {
    // The loud failure the guard above is guarding. A mis-described parameter
    // would have the model confidently sending a value the tool cannot parse.
    expect(() =>
      toRealtimeTool('read_page', fakeTool({ inputSchema: z.object({ when: z.date() }) })),
    ).toThrow(/Date cannot be represented in JSON Schema/);
  });

  it('given any tool, should emit the FLAT realtime function shape', () => {
    for (const tool of buildRealtimeTools(smallSet())) {
      expect(tool.type).toBe('function');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.parameters).toBeTypeOf('object');
      // Flat — NOT nested under a `function` key the way Chat Completions nests.
      expect(tool).not.toHaveProperty('function');
      expect(Object.keys(tool).sort()).toEqual([
        'description',
        'name',
        'parameters',
        'type',
      ]);
    }
  });

  it('given a zod-object inputSchema, should emit inlined JSON Schema parameters', () => {
    const [readPage] = buildRealtimeTools({
      read_page: fakeTool({
        description: 'Read a page.',
        inputSchema: z.object({
          pageId: z.string().describe('The page to read'),
          lines: z.number().optional(),
        }),
      }),
    });

    expect(readPage.parameters).toEqual({
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'The page to read' },
        lines: { type: 'number' },
      },
      required: ['pageId'],
      additionalProperties: false,
    });
  });

  it('given a schema that reuses a sub-schema, should inline it with no $ref/$defs', () => {
    const shared = z.object({ id: z.string() });
    const [tool] = buildRealtimeTools({
      read_page: fakeTool({
        inputSchema: z.object({ from: shared, to: shared }),
      }),
    });

    const keys = deepKeys(tool.parameters);
    expect(keys).not.toContain('$ref');
    expect(keys).not.toContain('$defs');
    expect(keys.filter((k) => k.startsWith('$'))).toEqual([]);
    // Inlined means BOTH occurrences carry the real shape, not a pointer.
    expect(tool.parameters).toMatchObject({
      properties: {
        from: { type: 'object', properties: { id: { type: 'string' } } },
        to: { type: 'object', properties: { id: { type: 'string' } } },
      },
    });
  });

  it('given a schema, should drop the $schema dialect annotation from parameters', () => {
    // z.toJSONSchema emits `$schema` at the root; it describes the document, not
    // the parameter contract, and OpenAI function schemas never carry it.
    const raw = z.toJSONSchema(z.object({ pageId: z.string() })) as Record<string, unknown>;
    expect(raw.$schema).toBeDefined();

    const [tool] = buildRealtimeTools({ read_page: fakeTool() });
    expect(tool.parameters).not.toHaveProperty('$schema');
  });

  it('given a tool with no description, should still emit a valid definition', () => {
    const [tool] = buildRealtimeTools({
      read_page: fakeTool({ description: undefined }),
    });

    expect(tool).toEqual({
      type: 'function',
      name: 'read_page',
      description: '',
      parameters: {
        type: 'object',
        properties: { pageId: { type: 'string' } },
        required: ['pageId'],
        additionalProperties: false,
      },
    });
  });

  it('given a tool with a description, should carry it through verbatim', () => {
    const [tool] = buildRealtimeTools({
      read_page: fakeTool({ description: 'Read a page aloud.' }),
    });
    expect(tool.description).toBe('Read a page aloud.');
  });

  it('given the scaffolding tools, should describe them exactly as the text stack does', () => {
    // Built from the same factories, so voice and text cannot describe the two
    // discovery tools differently.
    const set = smallSet();
    const emitted = buildRealtimeTools(set);
    const search = emitted.find((t) => t.name === 'tool_search');
    const execute = emitted.find((t) => t.name === 'execute_tool');

    expect(search?.description).toBe(createToolSearchTool(set).description);
    expect(execute?.description).toBe(createExecuteTool({}).description);
    expect(search?.parameters).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
    // `parameters` carries a zod `.default({})` yet still lands in `required`:
    // z.toJSONSchema defaults to `io: 'output'`, where a defaulted field is
    // always present. Kept as-is rather than switched to `io: 'input'` — the
    // text stack's tool_search renders the same schema the same way, and a
    // field the model must always send (as `{}`) costs nothing.
    expect(execute?.parameters).toMatchObject({
      type: 'object',
      properties: { tool_name: { type: 'string' }, parameters: { type: 'object' } },
      required: ['tool_name', 'parameters'],
    });
  });

  it('given an empty tool set, should still emit the discovery scaffolding', () => {
    expect(names(buildRealtimeTools({}))).toEqual(['tool_search', 'execute_tool']);
  });

  it('given composer-toggled tools, should defer them like any other non-core tool', () => {
    // A voice call has no composer toggles, so `web_search`/`generate_image` get
    // no always-upfront rescue — they are reachable through execute_tool.
    const emitted = names(
      buildRealtimeTools({
        read_page: fakeTool(),
        web_search: fakeTool(),
        generate_image: fakeTool(),
      }),
    );
    expect(emitted).toEqual(['read_page', 'tool_search', 'execute_tool']);
  });

  it('given the same tool set twice, should be pure — equal output, input untouched', () => {
    const set = smallSet();
    const snapshot = Object.keys(set);
    expect(buildRealtimeTools(set)).toEqual(buildRealtimeTools(set));
    expect(Object.keys(set)).toEqual(snapshot);
    expect(set).not.toHaveProperty('tool_search');
  });
});
