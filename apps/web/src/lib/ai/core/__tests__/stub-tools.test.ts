import { describe, it } from 'vitest';
import { z } from 'zod';
import type { Tool } from 'ai';
import { assert } from './riteway';
import { CORE_TOOL_NAMES, buildStubbedTools } from '../stub-tools';

const fakeCore: Tool = {
  description: 'A core tool',
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }: { id: string }) => ({ result: id }),
};

const fakeExtended: Tool = {
  description: 'A non-core tool',
  inputSchema: z.object({ name: z.string(), date: z.string() }),
  execute: async ({ name }: { name: string }) => ({ result: name }),
};

const registry = {
  list_drives: fakeCore,
  list_calendar_events: fakeExtended,
};

describe('CORE_TOOL_NAMES', () => {
  it('contains exactly the 8 designated core tools', () => {
    assert({
      given: 'the CORE_TOOL_NAMES set',
      should: 'list exactly the 8 core tools',
      actual: [...CORE_TOOL_NAMES].sort(),
      expected: [
        'create_page',
        'get_page_details',
        'list_drives',
        'list_pages',
        'multi_drive_search',
        'read_page',
        'regex_search',
        'replace_lines',
      ],
    });
  });
});

describe('buildStubbedTools', () => {
  it('passes core tools through unchanged', () => {
    const stubbed = buildStubbedTools(registry);
    assert({
      given: 'a core tool (list_drives)',
      should: 'be the same object reference as the original',
      actual: stubbed.list_drives === registry.list_drives,
      expected: true,
    });
  });

  it('replaces non-core inputSchema with a passthrough that accepts any object', () => {
    const stubbed = buildStubbedTools(registry);
    const schema = stubbed.list_calendar_events.inputSchema as z.ZodType;
    assert({
      given: 'a non-core stub schema',
      should: 'accept any object',
      actual: schema.safeParse({ anything: true }).success,
      expected: true,
    });
    assert({
      given: 'a non-core stub schema',
      should: 'accept an empty object',
      actual: schema.safeParse({}).success,
      expected: true,
    });
  });

  it('preserves the description on non-core stubs', () => {
    const stubbed = buildStubbedTools(registry);
    assert({
      given: 'a non-core stub tool',
      should: 'keep its original description',
      actual: stubbed.list_calendar_events.description,
      expected: fakeExtended.description,
    });
  });

  it('stub execute delegates to real impl when args are valid', async () => {
    const stubbed = buildStubbedTools(registry);
    const result = await stubbed.list_calendar_events.execute!(
      { name: 'test', date: '2025-01-01' },
      {} as never
    );
    assert({
      given: 'valid args passed to a stub execute',
      should: 'delegate to the real execute function',
      actual: result,
      expected: { result: 'test' },
    });
  });

  it('stub execute returns a tool_search error for invalid args', async () => {
    const stubbed = buildStubbedTools(registry);
    const result = await stubbed.list_calendar_events.execute!(
      {},
      {} as never
    );
    assert({
      given: 'invalid args (missing required fields)',
      should: 'return an error that mentions tool_search',
      actual: (result as { error: string }).error.includes('tool_search'),
      expected: true,
    });
  });

  it('returns an empty object for an empty input registry', () => {
    assert({
      given: 'an empty tool registry',
      should: 'produce an empty stubbed registry',
      actual: buildStubbedTools({}),
      expected: {},
    });
  });
});
