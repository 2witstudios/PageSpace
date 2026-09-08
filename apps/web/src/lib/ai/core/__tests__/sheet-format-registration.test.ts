/**
 * `format_sheet` / `set_conditional_format` are reachable, and gated.
 *
 * The tools existed for a whole epic before anything registered them: the
 * skill told the model the capability did not exist and no tool set carried
 * the names. Each case here pins one seam of the wiring, against the REAL
 * registry, so the next tool module cannot ship the same way.
 *
 * The search-mode cases are written the only way they can mean anything. A
 * tool set built by `applyToolExposureMode(..., 'search')` has ONLY core tools
 * plus `tool_search` / `execute_tool` as top-level keys — neither sheet tool is
 * core (`CORE_TOOL_NAMES`) — so `expect(Object.keys(tools)).not.toContain(
 * 'format_sheet')` passes no matter what the read-only filter does. Reachability
 * is probed through `tool_search('select:name')` (the corpus `execute_tool`
 * dispatches from) and through a dispatch call itself.
 */
import { describe, it, expect } from 'vitest';
import type { Tool } from 'ai';
import { buildPageSpaceTools, TOOL_REGISTRY, WORKSPACE_TOOL_NAMES } from '../ai-tools';
import { WRITE_TOOLS, filterToolsForReadOnly } from '../tool-filtering';
import { CORE_TOOL_NAMES } from '../stub-tools';
import { applyToolExposureMode } from '../../tools/tool-exposure';
import { BUILTIN_SKILLS } from '@pagespace/lib/commands/command-core';
import { TOOL_NAME_MAP } from '../../tools/tool-labels';

const SHEET_FORMAT_TOOLS = ['format_sheet', 'set_conditional_format'] as const;

const base = buildPageSpaceTools({ codeExecutionEnabled: false });
const fullSearch = applyToolExposureMode(base, 'search').tools as Record<string, Tool>;
const readOnlySearch = applyToolExposureMode(filterToolsForReadOnly(base, true), 'search').tools as Record<string, Tool>;

const probe = async (tools: Record<string, Tool>, name: string): Promise<string[]> => {
  const search = tools.tool_search.execute as (a: unknown, o: unknown) => Promise<{ tools: Array<{ name: string }> }>;
  return (await search({ query: `select:${name}` }, {})).tools.map((t) => t.name);
};

const dispatch = (tools: Record<string, Tool>, name: string): Promise<{ error?: string }> => {
  const exec = tools.execute_tool.execute as (a: unknown, o: unknown) => Promise<{ error?: string }>;
  return exec({ tool_name: name, parameters: {} }, { experimental_context: {} });
};

describe('sheet formatting tools — registration', () => {
  it('TOOL_REGISTRY.sheetsFormat is exactly the two tools', () => {
    expect([...TOOL_REGISTRY.sheetsFormat].sort()).toEqual([...SHEET_FORMAT_TOOLS].sort());
  });

  it('both names are workspace tools on the code-exec-off build', () => {
    for (const name of SHEET_FORMAT_TOOLS) {
      expect(WORKSPACE_TOOL_NAMES).toContain(name);
      expect(base[name]).toBeDefined();
    }
  });

  it('both have a curated label', () => {
    expect(TOOL_NAME_MAP.format_sheet).toBe('Format Sheet');
    expect(TOOL_NAME_MAP.set_conditional_format).toBe('Conditional Formatting');
  });

  it('the spreadsheets skill is discoverable through either formatting tool and its description names formatting', () => {
    // requiredTools is .some()-gated: an agent whose allowlist holds only
    // set_conditional_format (plus load_skill) must still be offered the
    // skill that carries the rule semantics. The description is the model's
    // only retrieval signal; these are the words a person types.
    const skill = BUILTIN_SKILLS.find((s) => s.trigger === 'spreadsheets')!;
    for (const name of SHEET_FORMAT_TOOLS) {
      expect(skill.requiredTools, name).toContain(name);
    }
    for (const word of ['format', 'dashboard', 'presentable']) {
      expect(skill.description.toLowerCase()).toContain(word);
    }
  });
});

describe('sheet formatting tools — gating', () => {
  it('WRITE_TOOLS contains both names (direct)', () => {
    for (const name of SHEET_FORMAT_TOOLS) {
      expect(WRITE_TOOLS.has(name), name).toBe(true);
    }
  });

  it('a read-only agent loses both, and keeps read_sheet', () => {
    const readOnly = filterToolsForReadOnly(base, true);
    for (const name of SHEET_FORMAT_TOOLS) {
      expect(readOnly[name], name).toBeUndefined();
    }
    expect(readOnly.read_sheet).toBeDefined();
  });

  it('neither is a core tool, so the search-mode key-set assertion would be vacuous', () => {
    // The premise of the probes below, pinned so that a future edit making
    // one of them core does not silently turn the probes into no-ops of a
    // different kind.
    for (const name of SHEET_FORMAT_TOOLS) {
      expect(CORE_TOOL_NAMES.has(name), name).toBe(false);
    }
  });

  it('search mode: tool_search finds both on a full agent and neither on a read-only agent', async () => {
    for (const name of SHEET_FORMAT_TOOLS) {
      expect(await probe(fullSearch, name), `${name} on a full agent`).toEqual([name]);
      expect(await probe(readOnlySearch, name), `${name} on a read-only agent`).toEqual([]);
    }
    // The probe itself is live: a read tool is still found on the read-only
    // set, so an empty result above is the filter, not a dead probe.
    expect(await probe(readOnlySearch, 'read_sheet')).toEqual(['read_sheet']);
  });

  it('search mode: execute_tool dispatches to both on a full agent and reports them unknown on a read-only agent', async () => {
    for (const name of SHEET_FORMAT_TOOLS) {
      // On the full set the call REACHES the tool: with an empty context the
      // tool's own auth guard throws, which is a different failure from the
      // dispatcher's unknown-tool envelope.
      await expect(dispatch(fullSearch, name), `${name} on a full agent`).rejects.toThrow('User authentication required');
      expect((await dispatch(readOnlySearch, name)).error, `${name} on a read-only agent`).toContain(`Unknown tool "${name}"`);
    }
  });

  it('search mode: the read-only filter composes with search exposure for EVERY registered write tool', async () => {
    // The general form of the two cases above, so the next write tool cannot
    // be discoverable through tool_search on a read-only agent without a
    // test noticing. Neither tool-filtering.test nor tool-exposure.test runs
    // the two mechanisms together against the real registry.
    const writeTools = Object.keys(base).filter((name) => WRITE_TOOLS.has(name) && !CORE_TOOL_NAMES.has(name));
    expect(writeTools).toEqual(expect.arrayContaining([...SHEET_FORMAT_TOOLS]));
    for (const name of writeTools) {
      expect(await probe(fullSearch, name), `${name} on a full agent`).toEqual([name]);
      expect(await probe(readOnlySearch, name), `${name} on a read-only agent`).toEqual([]);
    }
  });
});
