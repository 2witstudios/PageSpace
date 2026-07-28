import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';
import {
  applyToolExposureMode,
  splitToolsForExposure,
  excludeAlwaysUpfront,
  ALWAYS_UPFRONT_TOOLS,
} from '../tool-exposure';
import { CORE_TOOL_NAMES } from '../../core/stub-tools';

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

describe('ALWAYS_UPFRONT_TOOLS', () => {
  it('covers exactly the tools that bypass the agent allowlist on the way in', () => {
    // One shared set, imported by api/ai/chat and api/ai/global/[id]/messages, so a new
    // allowlist-bypassing override cannot be wired into one route and forgotten in the
    // other. Membership is NOT "shares a composer toggle" — it is "re-added after
    // filterToolsForAgentAllowlist", which is what makes execute_tool's re-check reject
    // it if deferred. web_fetch shares the web-search toggle but has no such bypass, so
    // it is correctly absent. See the constant's doc comment.
    expect([...ALWAYS_UPFRONT_TOOLS].sort()).toEqual(['generate_image', 'web_search']);
    expect(ALWAYS_UPFRONT_TOOLS.has('web_fetch')).toBe(false);
  });

  it('promotes its members past the core-only split', () => {
    const tools: ToolSet = {
      read_page: makeTool('Read a page'),
      generate_image: makeTool('Generate an image'),
      web_search: makeTool('Search the web'),
      list_agents: makeTool('List agents'),
    } as ToolSet;

    const { coreTools, nonCoreTools } = splitToolsForExposure(tools, ALWAYS_UPFRONT_TOOLS);

    for (const name of ALWAYS_UPFRONT_TOOLS) {
      expect(coreTools[name], `${name} must be directly callable`).toBeDefined();
      expect(nonCoreTools[name]).toBeUndefined();
    }
  });
});

describe('splitToolsForExposure', () => {
  it('keeps always-upfront tools alongside core tools, deferring only the rest', () => {
    // The Global Assistant bug: generate_image/web_search were advertised by name in
    // the system prompt but only ever reachable via execute_tool, so a direct call
    // was rejected as an unknown tool. They must land in coreTools.
    const tools: ToolSet = {
      generate_image: makeTool('Generate an image'),
      web_search: makeTool('Search the web'),
      read_page: makeTool('Read a page'), // core
      list_agents: makeTool('List agents'), // non-core
    } as ToolSet;

    const { coreTools, nonCoreTools } = splitToolsForExposure(
      tools,
      new Set(['web_search', 'generate_image'])
    );

    expect(Object.keys(coreTools).sort()).toEqual(['generate_image', 'read_page', 'web_search']);
    expect(Object.keys(nonCoreTools)).toEqual(['list_agents']);
    // The tool values are passed through untouched.
    expect(coreTools.generate_image).toBe(tools.generate_image);
    expect(nonCoreTools.list_agents).toBe(tools.list_agents);
  });

  it('falls back to CORE_TOOL_NAMES-only behaviour for an empty or omitted alwaysUpfront', () => {
    const tools = sampleTools();
    const expectedCore = Object.keys(tools).filter((n) => CORE_TOOL_NAMES.has(n));
    const expectedNonCore = Object.keys(tools).filter((n) => !CORE_TOOL_NAMES.has(n));

    const withEmptySet = splitToolsForExposure(tools, new Set());
    const withDefault = splitToolsForExposure(tools);

    for (const result of [withEmptySet, withDefault]) {
      expect(Object.keys(result.coreTools)).toEqual(expectedCore);
      expect(Object.keys(result.nonCoreTools)).toEqual(expectedNonCore);
    }
  });

  it('returns two empty objects for an empty tool set', () => {
    const { coreTools, nonCoreTools } = splitToolsForExposure({} as ToolSet, new Set(['web_search']));

    expect(coreTools).toEqual({});
    expect(nonCoreTools).toEqual({});
  });

  it('does not duplicate or drop a tool that is both core and always-upfront', () => {
    const tools: ToolSet = {
      read_page: makeTool('Read a page'), // core AND named in alwaysUpfront
      list_agents: makeTool('List agents'), // non-core
    } as ToolSet;

    const { coreTools, nonCoreTools } = splitToolsForExposure(tools, new Set(['read_page']));

    expect(Object.keys(coreTools)).toEqual(['read_page']);
    expect(Object.keys(nonCoreTools)).toEqual(['list_agents']);
  });

  it('never places the same tool in both halves', () => {
    const tools: ToolSet = {
      read_page: makeTool('Read a page'),
      web_search: makeTool('Search the web'),
      list_agents: makeTool('List agents'),
    } as ToolSet;

    const { coreTools, nonCoreTools } = splitToolsForExposure(tools, new Set(['web_search']));

    const coreNames = Object.keys(coreTools);
    const nonCoreNames = Object.keys(nonCoreTools);
    expect(coreNames.filter((n) => nonCoreNames.includes(n))).toEqual([]);
    expect([...coreNames, ...nonCoreNames].sort()).toEqual(Object.keys(tools).sort());
  });
});

describe('excludeAlwaysUpfront', () => {
  it('omits always-upfront tools so they are never discovered as execute_tool targets', () => {
    // TOOL_DISCOVERY_PROMPT tells the model to run anything it discovers via
    // execute_tool. An always-upfront tool is NOT in execute_tool's dispatch map,
    // so leaving it in the searchable catalog invites a dead-end call — the same
    // "advertised but not callable" failure this module exists to prevent.
    const tools: ToolSet = {
      read_page: makeTool('Read a page'), // core
      generate_image: makeTool('Generate an image'), // always-upfront
      web_search: makeTool('Search the web'), // always-upfront
      list_agents: makeTool('List agents'), // non-core
    } as ToolSet;

    const catalog = excludeAlwaysUpfront(tools, new Set(['web_search', 'generate_image']));

    expect(Object.keys(catalog).sort()).toEqual(['list_agents', 'read_page']);
  });

  it('returns the full set for an empty or omitted alwaysUpfront', () => {
    const tools = sampleTools();

    expect(Object.keys(excludeAlwaysUpfront(tools, new Set()))).toEqual(Object.keys(tools));
    expect(Object.keys(excludeAlwaysUpfront(tools))).toEqual(Object.keys(tools));
  });

  it('returns an empty catalog for an empty tool set', () => {
    expect(excludeAlwaysUpfront({} as ToolSet, new Set(['web_search']))).toEqual({});
  });

  it('never surfaces a tool that is absent from the execute_tool dispatch map', () => {
    // Ties the two halves together: everything left in the catalog must be either a
    // core tool (callable directly) or present in nonCoreTools (callable via
    // execute_tool). Nothing may be discoverable yet unreachable.
    const tools: ToolSet = {
      read_page: makeTool('Read a page'),
      generate_image: makeTool('Generate an image'),
      list_agents: makeTool('List agents'),
    } as ToolSet;
    const alwaysUpfront = new Set(['generate_image']);

    const { coreTools, nonCoreTools } = splitToolsForExposure(tools, alwaysUpfront);
    const catalog = excludeAlwaysUpfront(tools, alwaysUpfront);

    for (const name of Object.keys(catalog)) {
      const reachable = CORE_TOOL_NAMES.has(name) || name in nonCoreTools;
      expect(reachable, `${name} is searchable but unreachable`).toBe(true);
    }
    // generate_image stays reachable — directly, as a top-level tool.
    expect(coreTools.generate_image).toBeDefined();
    expect(catalog.generate_image).toBeUndefined();
  });
});

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

    it('a tool absent from the catalog is unreachable via execute_tool', async () => {
      // delete_task was excluded by the agent allowlist upstream, so it never enters
      // the catalog. The model therefore cannot dispatch it through execute_tool —
      // this proves catalog/dispatch-map exclusion (the enabledTools gate itself is
      // covered by execute-tool's own tests).
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

  describe('alwaysUpfront overrides (e.g. web_search runtime toggle)', () => {
    it('keeps an always-upfront tool directly callable instead of behind execute_tool', () => {
      const tools: ToolSet = {
        read_page: makeTool('Read a page'), // core
        send_channel_message: makeTool('Send a channel message'), // non-core
        web_search: makeTool('Search the web'), // runtime override
      } as ToolSet;

      const result = applyToolExposureMode(tools, 'search', new Set(['web_search']));

      // web_search stays directly callable, NOT deferred behind execute_tool.
      expect(result.tools.web_search).toBeDefined();
      // The genuinely non-core tool is still deferred.
      expect(result.tools.send_channel_message).toBeUndefined();
      expect(result.tools.tool_search).toBeDefined();
      expect(result.tools.execute_tool).toBeDefined();
    });

    it('does not reject an always-upfront tool via execute_tool when the allowlist omits it', async () => {
      // Mirrors the real bug: agent allowlist excludes web_search, but the runtime
      // toggle injected it. enabledTools (the saved allowlist) does NOT contain it.
      const tools: ToolSet = {
        read_page: makeTool('Read a page'),
        send_channel_message: makeTool('Send a channel message'),
        web_search: makeTool('Search the web'),
      } as ToolSet;

      const result = applyToolExposureMode(tools, 'search', new Set(['web_search']));

      // web_search is reachable directly (no execute_tool / allowlist gate involved).
      expect(result.tools.web_search).toBeDefined();
      // It is NOT in the execute_tool dispatch map: even with an allowlist that
      // permits it (so the allowlist gate passes), execute_tool can't find it —
      // proving it is served upfront, not deferred.
      const execTool = result.tools.execute_tool as Tool;
      const out = (await (execTool.execute as (a: unknown, o: unknown) => Promise<unknown>)(
        { tool_name: 'web_search', parameters: {} },
        { experimental_context: { enabledTools: ['read_page', 'web_search'] } }
      )) as { error?: string };
      expect(out.error).toMatch(/Unknown tool "web_search"/);
    });

    it('excludes always-upfront tools from the tool_search catalog', async () => {
      const tools: ToolSet = {
        read_page: makeTool('Read a page'),
        send_channel_message: makeTool('Send a channel message'),
        web_search: makeTool('Search the web'),
      } as ToolSet;

      const result = applyToolExposureMode(tools, 'search', new Set(['web_search']));
      const searchTool = result.tools.tool_search as Tool;
      const found = (await (searchTool.execute as (a: unknown, o: unknown) => Promise<unknown>)(
        { query: 'web' },
        {}
      )) as { tools: Array<{ name: string }> };
      expect(found.tools.map((t) => t.name)).not.toContain('web_search');
    });

    it('keeps a tool that is both core and always-upfront exactly once (no drop, no duplicate)', () => {
      // read_page is a core tool AND named in alwaysUpfront — the overlap must not
      // drop it or list it twice in the resulting toolset.
      const tools: ToolSet = {
        read_page: makeTool('Read a page'), // core + always-upfront
        send_channel_message: makeTool('Send a channel message'), // non-core, forces a split
      } as ToolSet;

      const result = applyToolExposureMode(tools, 'search', new Set(['read_page']));

      expect(result.tools.read_page).toBeDefined();
      // Present exactly once (object keys are unique, but assert the count of the name).
      expect(Object.keys(result.tools).filter((k) => k === 'read_page')).toHaveLength(1);
      // Still split because a genuine non-core tool remains.
      expect(result.tools.tool_search).toBeDefined();
      expect(result.tools.execute_tool).toBeDefined();
    });

    it('treats search mode as a no-op when only core tools and always-upfront tools remain', () => {
      const tools: ToolSet = {
        read_page: makeTool('Read a page'), // core
        web_search: makeTool('Search the web'), // override
      } as ToolSet;

      const result = applyToolExposureMode(tools, 'search', new Set(['web_search']));

      expect(result.tools).toBe(tools);
      expect(result.toolDiscoveryPrompt).toBe('');
      expect(result.tools.tool_search).toBeUndefined();
    });
  });
});
