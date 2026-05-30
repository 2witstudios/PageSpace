import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';
import { applyToolExposureMode } from '../tool-exposure';

// A minimal but real tool definition (matches the AI SDK Tool shape closely enough
// for the catalog/dispatch logic under test).
function makeTool(description: string): Tool {
  return {
    description,
    inputSchema: z.object({ value: z.string().optional() }),
    execute: async () => ({ ok: true }),
  } as Tool;
}

// Includes a mix of core (see stub-tools.ts) and non-core tool names.
function sampleTools(): ToolSet {
  return {
    read_page: makeTool('Read a page'), // core
    create_page: makeTool('Create a page'), // core
    send_channel_message: makeTool('Send a channel message'), // non-core
    create_calendar_event: makeTool('Create a calendar event'), // non-core
  } as ToolSet;
}

describe('applyToolExposureMode', () => {
  describe('upfront mode', () => {
    it('returns the tools unchanged with no discovery prompt', () => {
      const tools = sampleTools();
      const result = applyToolExposureMode(tools, 'upfront');

      expect(result.tools).toBe(tools);
      expect(result.toolDiscoveryPrompt).toBe('');
      expect(Object.keys(result.tools).sort()).toEqual(
        ['create_calendar_event', 'create_page', 'read_page', 'send_channel_message']
      );
      expect(result.tools.tool_search).toBeUndefined();
      expect(result.tools.execute_tool).toBeUndefined();
    });
  });

  describe('search mode', () => {
    it('keeps core tools upfront and replaces non-core tools with tool_search/execute_tool', () => {
      const result = applyToolExposureMode(sampleTools(), 'search');

      // Core tools remain directly callable.
      expect(result.tools.read_page).toBeDefined();
      expect(result.tools.create_page).toBeDefined();
      // Non-core tools are removed from the upfront set.
      expect(result.tools.send_channel_message).toBeUndefined();
      expect(result.tools.create_calendar_event).toBeUndefined();
      // Discovery meta-tools are injected.
      expect(result.tools.tool_search).toBeDefined();
      expect(result.tools.execute_tool).toBeDefined();
    });

    it('appends a discovery prompt listing the deferred non-core tools', () => {
      const result = applyToolExposureMode(sampleTools(), 'search');

      expect(result.toolDiscoveryPrompt).toContain('TOOLS:');
      expect(result.toolDiscoveryPrompt).toContain('send_channel_message');
      expect(result.toolDiscoveryPrompt).toContain('create_calendar_event');
    });

    it('exposes a non-core tool only via execute_tool, never as a top-level tool', async () => {
      const allowlistFiltered: ToolSet = {
        read_page: makeTool('Read a page'), // core, allowed
        send_channel_message: makeTool('Send a channel message'), // non-core, allowed
      } as ToolSet;

      const result = applyToolExposureMode(allowlistFiltered, 'search');

      // Not reachable directly...
      expect(result.tools.send_channel_message).toBeUndefined();
      // ...but reachable through the execute_tool dispatch map.
      const execTool = result.tools.execute_tool as Tool;
      const out = await (execTool.execute as (a: unknown, o: unknown) => Promise<unknown>)(
        { tool_name: 'send_channel_message', parameters: { value: 'hi' } },
        { experimental_context: {} }
      );
      expect(out).toEqual({ ok: true });
    });

    it('cannot reach a tool that was filtered out of the catalog (allowlist enforcement)', async () => {
      // delete_task is NOT in the catalog (excluded by the agent allowlist upstream).
      const allowlistFiltered: ToolSet = {
        read_page: makeTool('Read a page'),
        send_channel_message: makeTool('Send a channel message'),
      } as ToolSet;

      const result = applyToolExposureMode(allowlistFiltered, 'search');
      const execTool = result.tools.execute_tool as Tool;
      const out = (await (execTool.execute as (a: unknown, o: unknown) => Promise<unknown>)(
        { tool_name: 'delete_task', parameters: {} },
        { experimental_context: {} }
      )) as { error?: string };

      expect(out.error).toMatch(/Unknown tool "delete_task"/);
    });

    it('returns the upfront set unchanged when there are no non-core tools to defer', () => {
      const coreOnly: ToolSet = {
        read_page: makeTool('Read a page'),
        create_page: makeTool('Create a page'),
      } as ToolSet;

      const result = applyToolExposureMode(coreOnly, 'search');

      expect(result.tools).toBe(coreOnly);
      expect(result.toolDiscoveryPrompt).toBe('');
      expect(result.tools.tool_search).toBeUndefined();
      expect(result.tools.execute_tool).toBeUndefined();
    });

    it('returns an empty toolset unchanged with no discovery prompt', () => {
      const empty: ToolSet = {} as ToolSet;
      const result = applyToolExposureMode(empty, 'search');

      expect(result.tools).toBe(empty);
      expect(result.toolDiscoveryPrompt).toBe('');
    });
  });
});
