import { describe, it } from 'vitest';
import { z } from 'zod';
import type { Tool } from 'ai';
import { assert } from './riteway';
import { createToolSearchTool } from '../tool-search-tool';

const calendarTool: Tool = {
  description: 'List calendar events for a date range',
  inputSchema: z.object({ startDate: z.string(), endDate: z.string() }),
  execute: async () => ({ events: [] }),
};

const taskTool: Tool = {
  description: 'Update a task item',
  inputSchema: z.object({ taskId: z.string(), status: z.string() }),
  execute: async () => ({ success: true }),
};

const registry = {
  list_calendar_events: calendarTool,
  update_task: taskTool,
};

type ToolSearchResult = {
  tools: Array<{ name: string; description: string; inputSchema: { type: string } }>;
};

describe('createToolSearchTool', () => {
  it('returns a tool with a string description', () => {
    const t = createToolSearchTool(registry);
    assert({
      given: 'a tool registry',
      should: 'produce a tool_search tool with a string description',
      actual: typeof t.description,
      expected: 'string',
    });
  });

  it('select: query returns exactly the named tool', async () => {
    const t = createToolSearchTool(registry);
    const { tools } = (await t.execute!(
      { query: 'select:list_calendar_events' },
      {} as never
    )) as ToolSearchResult;
    assert({
      given: 'select:list_calendar_events',
      should: 'return one tool named list_calendar_events',
      actual: tools.map((x) => x.name),
      expected: ['list_calendar_events'],
    });
  });

  it('select: with two names returns both tools', async () => {
    const t = createToolSearchTool(registry);
    const { tools } = (await t.execute!(
      { query: 'select:list_calendar_events,update_task' },
      {} as never
    )) as ToolSearchResult;
    assert({
      given: 'select: with two valid names',
      should: 'return both tools',
      actual: tools.map((x) => x.name).sort(),
      expected: ['list_calendar_events', 'update_task'],
    });
  });

  it('select: with unknown name returns empty array', async () => {
    const t = createToolSearchTool(registry);
    const { tools } = (await t.execute!(
      { query: 'select:does_not_exist' },
      {} as never
    )) as ToolSearchResult;
    assert({
      given: 'select: with an unknown tool name',
      should: 'return no tools',
      actual: tools.length,
      expected: 0,
    });
  });

  it('keyword query matches on tool name', async () => {
    const t = createToolSearchTool(registry);
    const { tools } = (await t.execute!(
      { query: 'calendar' },
      {} as never
    )) as ToolSearchResult;
    assert({
      given: '"calendar" keyword',
      should: 'return the calendar event tool',
      actual: tools.map((x) => x.name),
      expected: ['list_calendar_events'],
    });
  });

  it('keyword query matches on description text', async () => {
    const t = createToolSearchTool(registry);
    const { tools } = (await t.execute!(
      { query: 'task item' },
      {} as never
    )) as ToolSearchResult;
    assert({
      given: '"task item" matching description',
      should: 'return update_task',
      actual: tools.map((x) => x.name),
      expected: ['update_task'],
    });
  });

  it('returned inputSchema has JSON Schema type:object', async () => {
    const t = createToolSearchTool(registry);
    const { tools } = (await t.execute!(
      { query: 'select:list_calendar_events' },
      {} as never
    )) as ToolSearchResult;
    assert({
      given: 'a tool with a Zod object schema',
      should: 'return a JSON Schema with type "object"',
      actual: tools[0].inputSchema.type,
      expected: 'object',
    });
  });

  it('unmatched keyword returns empty tools array', async () => {
    const t = createToolSearchTool(registry);
    const { tools } = (await t.execute!(
      { query: 'xyznonexistent123' },
      {} as never
    )) as ToolSearchResult;
    assert({
      given: 'a keyword matching nothing',
      should: 'return an empty tools array',
      actual: tools.length,
      expected: 0,
    });
  });
});
