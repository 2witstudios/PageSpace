import { describe, it } from 'vitest';
import { z } from 'zod';
import type { Tool } from 'ai';
import { assert } from './riteway';
import { createExecuteTool } from '../execute-tool';

const calendarTool: Tool = {
  description: 'List calendar events',
  inputSchema: z.object({ startDate: z.string(), endDate: z.string() }),
  execute: async ({ startDate }: { startDate: string; endDate: string }) => ({ events: [], startDate }),
};

const noExecTool: Tool = {
  description: 'Declaration only',
  inputSchema: z.object({ id: z.string() }),
};

const registry = {
  list_calendar_events: calendarTool,
  no_execute_tool: noExecTool,
};

describe('createExecuteTool', () => {
  it('returns a tool with a string description', () => {
    const t = createExecuteTool(registry);
    assert({
      given: 'a tool registry',
      should: 'produce an execute_tool with a string description',
      actual: typeof t.description,
      expected: 'string',
    });
  });

  it('unknown tool_name returns an error with tool_search hint', async () => {
    const t = createExecuteTool(registry);
    const result = await t.execute!({ tool_name: 'does_not_exist', parameters: {} }, {} as never) as { error: string };
    assert({
      given: 'an unknown tool_name with nothing close to it in the registry',
      should: 'return an error message mentioning tool_search',
      actual: result.error.includes('tool_search'),
      expected: true,
    });
  });

  it('a near-miss tool_name is suggested instead of a bare tool_search hint', async () => {
    const t = createExecuteTool({ ...registry, readFile: calendarTool });
    const result = await t.execute!({ tool_name: 'read_file', parameters: {} }, {} as never) as { error: string };
    assert({
      given: 'a snake_case guess at a camelCase tool that exists',
      should: 'name the real tool in the error',
      actual: result.error.includes('Did you mean: readFile'),
      expected: true,
    });
  });

  it('suggestions never name a tool the caller is not allowed to run', async () => {
    const t = createExecuteTool({ ...registry, readFile: calendarTool });
    const opts = { experimental_context: { enabledTools: ['list_calendar_events'] } };
    const result = await t.execute!(
      { tool_name: 'read_file', parameters: {} },
      opts as never
    ) as { error: string };
    assert({
      given: 'a near-miss name whose match is outside the caller enabledTools allowlist',
      should: 'not suggest the unreachable tool',
      actual: result.error.includes('readFile'),
      expected: false,
    });
  });

  it('tool without execute returns an error', async () => {
    const t = createExecuteTool(registry);
    const result = await t.execute!({ tool_name: 'no_execute_tool', parameters: { id: '1' } }, {} as never) as { error: string };
    assert({
      given: 'a tool with no execute function',
      should: 'return an error about no execute implementation',
      actual: typeof result.error,
      expected: 'string',
    });
  });

  it('invalid parameters return an error carrying the tool schema inline', async () => {
    const t = createExecuteTool(registry);
    const result = await t.execute!({ tool_name: 'list_calendar_events', parameters: {} }, {} as never) as { error: string };
    assert({
      given: 'missing required parameters',
      should: 'name the tool and inline the parameter names, so the next call needs no tool_search',
      actual: (() => {
        const marker = 'Input schema for "list_calendar_events": ';
        if (!result.error.includes(marker) || result.error.includes('tool_search')) return null;
        const schema = JSON.parse(result.error.slice(result.error.indexOf(marker) + marker.length)) as {
          required: string[];
        };
        return schema.required.slice().sort();
      })(),
      expected: ['endDate', 'startDate'],
    });
  });

  it('a mis-named parameter is correctable from the error alone', async () => {
    const t = createExecuteTool({ trash_page: { description: 'Trash a page', inputSchema: z.object({ id: z.string() }), execute: async () => 'ok' } });
    const result = await t.execute!({ tool_name: 'trash_page', parameters: { pageId: 'p1' } }, {} as never) as { error: string };
    const marker = 'Input schema for "trash_page": ';
    const schemaJson = result.error.slice(result.error.indexOf(marker) + marker.length);
    const schema = JSON.parse(schemaJson) as { required: string[] };
    assert({
      given: 'the real pageId-for-id mistake from the reported session',
      should: 'return the schema as parseable JSON naming the key that was actually wanted',
      actual: schema.required,
      expected: ['id'],
    });
  });

  it('valid call dispatches to the real execute', async () => {
    const t = createExecuteTool(registry);
    const result = await t.execute!(
      { tool_name: 'list_calendar_events', parameters: { startDate: '2024-01-01', endDate: '2024-01-31' } },
      {} as never
    ) as { events: unknown[]; startDate: string };
    assert({
      given: 'valid parameters for list_calendar_events',
      should: 'return the real execute result',
      actual: result.startDate,
      expected: '2024-01-01',
    });
  });

  it('empty allowedTools returns unknown tool error for any call', async () => {
    const t = createExecuteTool({});
    const result = await t.execute!({ tool_name: 'anything', parameters: {} }, {} as never) as { error: string };
    assert({
      given: 'an empty registry',
      should: 'return an unknown tool error',
      actual: typeof result.error,
      expected: 'string',
    });
  });

  it('enabledTools allowlist blocks a tool not in the list', async () => {
    const t = createExecuteTool(registry);
    const opts = { experimental_context: { enabledTools: ['list_calendar_events'] } };
    const result = await t.execute!(
      { tool_name: 'no_execute_tool', parameters: { id: '1' } },
      opts as never
    ) as { error: string };
    assert({
      given: 'a context with enabledTools that does not include the called tool',
      should: 'return a not-permitted error before execution',
      actual: result.error.includes('not permitted'),
      expected: true,
    });
  });

  it('enabledTools allowlist allows a tool in the list', async () => {
    const t = createExecuteTool(registry);
    const opts = { experimental_context: { enabledTools: ['list_calendar_events'] } };
    const result = await t.execute!(
      { tool_name: 'list_calendar_events', parameters: { startDate: '2024-01-01', endDate: '2024-01-31' } },
      opts as never
    ) as { startDate: string };
    assert({
      given: 'a context with enabledTools that includes the called tool',
      should: 'dispatch to the tool execute function',
      actual: result.startDate,
      expected: '2024-01-01',
    });
  });

  it('null enabledTools allows all tools', async () => {
    const t = createExecuteTool(registry);
    const opts = { experimental_context: { enabledTools: null } };
    const result = await t.execute!(
      { tool_name: 'list_calendar_events', parameters: { startDate: '2024-01-01', endDate: '2024-01-31' } },
      opts as never
    ) as { startDate: string };
    assert({
      given: 'a context with enabledTools: null (unrestricted)',
      should: 'allow all tool calls',
      actual: result.startDate,
      expected: '2024-01-01',
    });
  });
});
