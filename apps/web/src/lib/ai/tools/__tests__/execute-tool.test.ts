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
      given: 'an unknown tool_name',
      should: 'return an error message mentioning tool_search',
      actual: result.error.includes('tool_search'),
      expected: true,
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

  it('invalid parameters return an error with tool_search hint', async () => {
    const t = createExecuteTool(registry);
    const result = await t.execute!({ tool_name: 'list_calendar_events', parameters: {} }, {} as never) as { error: string };
    assert({
      given: 'missing required parameters',
      should: 'return an error mentioning tool_search and the tool name',
      actual: result.error.includes('list_calendar_events') && result.error.includes('tool_search'),
      expected: true,
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
});
