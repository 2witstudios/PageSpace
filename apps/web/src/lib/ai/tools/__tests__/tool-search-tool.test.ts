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
  skills?: Array<{ name: string; description: string; usage: string }>;
};

const skillCorpus = [
  { name: 'canvas-websites', description: 'Builds websites and landing pages on CANVAS pages.' },
  { name: 'standup', description: 'Prepares standup notes.' },
];

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

  it('without a skill corpus the output is byte-identical to the tools-only shape', async () => {
    const t = createToolSearchTool(registry);
    const result = (await t.execute!({ query: 'calendar' }, {} as never)) as ToolSearchResult;
    assert({
      given: 'no skills passed (default)',
      should: 'omit the skills key entirely',
      actual: 'skills' in result,
      expected: false,
    });
  });

  it('keyword query matches skills by description and returns a load_skill pointer', async () => {
    const t = createToolSearchTool(registry, skillCorpus);
    const result = (await t.execute!({ query: 'website' }, {} as never)) as ToolSearchResult;
    assert({
      given: '"website" keyword with a skill corpus',
      should: 'return the canvas-websites skill with load usage',
      actual: result.skills?.map((s) => `${s.name}|${s.usage}`),
      expected: ['canvas-websites|load_skill("canvas-websites")'],
    });
  });

  it('select: resolves skill names alongside tool names', async () => {
    const t = createToolSearchTool(registry, skillCorpus);
    const result = (await t.execute!(
      { query: 'select:update_task,standup' },
      {} as never
    )) as ToolSearchResult;
    assert({
      given: 'select: naming one tool and one skill',
      should: 'return the tool schema and the skill pointer',
      actual: [result.tools.map((x) => x.name), result.skills?.map((s) => s.name)],
      expected: [['update_task'], ['standup']],
    });
  });

  it('omits the skills key when the query matches no skill', async () => {
    const t = createToolSearchTool(registry, skillCorpus);
    const result = (await t.execute!({ query: 'calendar' }, {} as never)) as ToolSearchResult;
    assert({
      given: 'a query matching tools but no skills',
      should: 'omit the skills key',
      actual: 'skills' in result,
      expected: false,
    });
  });

  it('rejects empty/whitespace queries instead of dumping the whole corpus', async () => {
    const t = createToolSearchTool(registry, skillCorpus);
    const empty = (await t.execute!({ query: '' }, {} as never)) as ToolSearchResult & {
      error?: string;
    };
    const blank = (await t.execute!({ query: '   ' }, {} as never)) as ToolSearchResult;
    assert({
      given: 'an empty query (includes("") would match every entry)',
      should: 'return no tools, no skills, and an error hint',
      actual: [empty.tools.length, 'skills' in empty, typeof empty.error, blank.tools.length],
      expected: [0, false, 'string', 0],
    });
  });

  it('caps skill matches and reports the omission count', async () => {
    const bigCorpus = Array.from({ length: 25 }, (_, i) => ({
      name: `standup-${String(i).padStart(2, '0')}`,
      description: 'Prepares standup notes.',
    }));
    const t = createToolSearchTool(registry, bigCorpus);
    const result = (await t.execute!({ query: 'standup' }, {} as never)) as ToolSearchResult & {
      note?: string;
    };
    assert({
      given: '25 matching skills with a cap of 10',
      should: 'return 10 matches and an omission note for the other 15',
      actual: [result.skills?.length, result.note?.includes('15 more')],
      expected: [10, true],
    });
  });
});
