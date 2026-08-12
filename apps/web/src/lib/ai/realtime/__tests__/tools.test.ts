import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';
import {
  buildRealtimeToolExposure,
  buildRealtimeToolSet,
  toRealtimeTool,
  toRealtimeTools,
  type ToolAllowlist,
} from '../tools';
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

/**
 * What the session would actually advertise: the exposure, projected. The two
 * steps are one call here because every case below is about the result of both.
 */
const advertised = (tools: ToolSet, allowlist: ToolAllowlist = null) =>
  toRealtimeTools(buildRealtimeToolExposure(tools, allowlist).tools);

/** Every key anywhere in a JSON value, at any depth. */
function deepKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(deepKeys);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    k,
    ...deepKeys(v),
  ]);
}

describe('the advertised tool definitions', () => {
  it('given the full PageSpace ToolSet, should emit exactly the core tools plus the two scaffolding tools', () => {
    const registry = buildPageSpaceTools({ codeExecutionEnabled: true });
    const emitted = names(advertised(registry));
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
    const emitted = new Set(names(advertised(registry)));
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
    expect(() => advertised(registry)).not.toThrow();
  });

  it('given an unrepresentable input schema, should throw rather than emit a lie', () => {
    // The loud failure the guard above is guarding. A mis-described parameter
    // would have the model confidently sending a value the tool cannot parse.
    expect(() =>
      toRealtimeTool('read_page', fakeTool({ inputSchema: z.object({ when: z.date() }) })),
    ).toThrow(/Date cannot be represented in JSON Schema/);
  });

  it('given any tool, should emit the FLAT realtime function shape', () => {
    for (const tool of advertised(smallSet())) {
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
    const [readPage] = advertised({
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
    const [tool] = advertised({
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

    const [tool] = advertised({ read_page: fakeTool() });
    expect(tool.parameters).not.toHaveProperty('$schema');
  });

  it('given a tool with no description, should still emit a valid definition', () => {
    const [tool] = advertised({
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
    const [tool] = advertised({
      read_page: fakeTool({ description: 'Read a page aloud.' }),
    });
    expect(tool.description).toBe('Read a page aloud.');
  });

  it('given the scaffolding tools, should describe them exactly as the text stack does', () => {
    // Built from the same factories, so voice and text cannot describe the two
    // discovery tools differently.
    const set = smallSet();
    const emitted = advertised(set);
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

  it('given an empty tool set, should emit NOTHING — not scaffolding over an empty catalog', () => {
    // Was: scaffolding regardless. `tool_search` over nothing and an
    // `execute_tool` that can only refuse are two tools whose every call fails,
    // which is worse than two tools absent. This is applyToolExposureMode's own
    // rule (tool-exposure.ts:130-132), now shared rather than re-decided.
    expect(names(advertised({}))).toEqual([]);
  });

  it('given only core tools, should skip the scaffolding — there is nothing to discover', () => {
    expect(names(advertised({ read_page: fakeTool() }))).toEqual(['read_page']);
  });

  it('given composer-toggled tools, should defer them like any other non-core tool', () => {
    // A voice call has no composer toggles, so `web_search`/`generate_image` get
    // no always-upfront rescue — they are reachable through execute_tool.
    const emitted = names(
      advertised({
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
    expect(advertised(set)).toEqual(advertised(set));
    expect(Object.keys(set)).toEqual(snapshot);
    expect(set).not.toHaveProperty('tool_search');
  });
});

/**
 * The half voice used to throw away.
 *
 * `tool_search` and `execute_tool` rode every session while nothing in the
 * instructions named them, so every deferred tool — the calendar family,
 * spawn_session, create_task, the workflow tools — was loaded and undiscoverable,
 * and the model answered "I can't do that" about tools it was holding. The
 * exposure now carries the text describing itself.
 */
describe('buildRealtimeToolExposure — the discovery prompt', () => {
  it('given deferred tools, should return the prompt that tells the model how to reach them', () => {
    const { toolDiscoveryPrompt } = buildRealtimeToolExposure(smallSet());

    expect(toolDiscoveryPrompt).toContain('execute_tool');
    expect(toolDiscoveryPrompt).toContain('tool_search');
  });

  it('should name the deferred tools, so the model knows what exists before it searches', () => {
    const { toolDiscoveryPrompt } = buildRealtimeToolExposure({
      read_page: fakeTool(),
      create_task: fakeTool(),
      rename_drive: fakeTool(),
    });

    expect(toolDiscoveryPrompt).toContain('create_task');
    expect(toolDiscoveryPrompt).toContain('rename_drive');
  });

  it('should describe only tools the allowlist permits', () => {
    // A name in the prompt is an invitation to call it. Naming a blocked tool
    // both leaks the agent's configuration and spends a turn on a refusal.
    const { toolDiscoveryPrompt } = buildRealtimeToolExposure(
      { read_page: fakeTool(), create_task: fakeTool(), rename_drive: fakeTool() },
      ['read_page', 'create_task'],
    );

    expect(toolDiscoveryPrompt).toContain('create_task');
    expect(toolDiscoveryPrompt).not.toContain('rename_drive');
  });

  it('given nothing to defer, should return no prompt rather than an empty instruction', () => {
    expect(buildRealtimeToolExposure({ read_page: fakeTool() }).toolDiscoveryPrompt).toBe('');
    expect(buildRealtimeToolExposure({}).toolDiscoveryPrompt).toBe('');
  });

  it('should describe the SAME tools it advertises, never a wider or narrower set', () => {
    // The prompt and the tool set are one decision. If they can disagree, the
    // model is either told about a tool nothing answers, or holds one it was
    // never told it had — which is the bug this whole seam exists to prevent.
    const registry = buildPageSpaceTools({ codeExecutionEnabled: true });
    const { tools, toolDiscoveryPrompt } = buildRealtimeToolExposure(registry);

    const advertised = new Set(Object.keys(tools));
    const deferred = Object.keys(registry).filter((n) => !advertised.has(n));

    expect(deferred.length).toBeGreaterThan(0);
    for (const name of deferred) {
      expect(toolDiscoveryPrompt, `deferred tool "${name}" is not named in the prompt`).toContain(
        name,
      );
    }
  });
});

/**
 * The agent's allowlist is what its owner switched off. Advertising past it
 * told the model it could call write and delete tools an owner had disabled —
 * and because `execute_tool` reaches everything the split deferred, filtering
 * only the upfront half would have left them all callable anyway.
 */
describe('the advertised set — the bound agent allowlist', () => {
  it('given an allowlist, should advertise only what it names', () => {
    const emitted = names(
      advertised(
        { read_page: fakeTool(), delete_page: fakeTool(), rename_drive: fakeTool() },
        ['read_page', 'rename_drive'],
      ),
    );

    // rename_drive is allowed but non-core, so it defers behind the scaffolding
    // rather than being front-loaded. delete_page is not allowed and is nowhere.
    expect(emitted).toEqual(['read_page', 'tool_search', 'execute_tool']);
  });

  it('given null, should treat the agent as unrestricted', () => {
    const set = { read_page: fakeTool(), rename_drive: fakeTool() };
    expect(names(advertised(set, null))).toEqual(names(advertised(set)));
  });

  it('given an EMPTY allowlist, should advertise nothing at all', () => {
    // [] is "every PageSpace tool off", not "unconfigured" — and with every tool
    // off there is nothing for the scaffolding to reach either.
    const emitted = names(
      advertised({ read_page: fakeTool(), rename_drive: fakeTool() }, []),
    );

    expect(emitted).toEqual([]);
  });

  it('should keep a blocked tool out of the EXECUTABLE set as well, not just the advertised one', () => {
    // The advertised list is what the model is told about; execute_tool is how
    // it reaches everything else. A filter applied to only one of them is not a
    // filter.
    const executable = buildRealtimeToolSet(
      { read_page: fakeTool(), create_task: fakeTool(), rename_drive: fakeTool() },
      ['read_page', 'create_task'],
    );

    expect(Object.keys(executable).sort()).toEqual(
      ['execute_tool', 'read_page', 'tool_search'].sort(),
    );
  });

  it('should keep a blocked tool out of what tool_search can DESCRIBE', async () => {
    // Otherwise the model is handed the name and schema of a tool it is then
    // refused — which is both a leak of the agent's configuration and an
    // invitation to spend a turn failing.
    const search = buildRealtimeToolSet(
      { read_page: fakeTool(), create_task: fakeTool(), rename_drive: fakeTool() },
      ['read_page', 'create_task'],
    ).tool_search;
    const described = JSON.stringify(
      await (search.execute as (a: unknown, o: unknown) => unknown)(
        { query: 'rename' },
        { experimental_context: {}, toolCallId: 't1', messages: [] },
      ),
    );

    expect(described).not.toContain('rename_drive');
  });

  it('should never filter away the scaffolding itself', () => {
    // tool_search and execute_tool are how an allowlist is reached at all, not
    // capabilities an owner grants — so they appear even when the allowlist
    // names neither of them, as no allowlist ever does.
    const emitted = names(
      advertised({ read_page: fakeTool(), rename_drive: fakeTool() }, ['rename_drive']),
    );
    expect(emitted).toEqual(['tool_search', 'execute_tool']);
  });
});
