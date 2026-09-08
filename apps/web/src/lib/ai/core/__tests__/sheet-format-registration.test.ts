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
 * is probed through `tool_search('select:format_sheet')` (the corpus
 * `execute_tool` dispatches from) and through a dispatch call itself.
 */
import { describe, it, expect } from 'vitest';
import type { Tool } from 'ai';
import { buildPageSpaceTools, TOOL_REGISTRY, WORKSPACE_TOOL_NAMES } from '../ai-tools';
import { WRITE_TOOLS, filterToolsForReadOnly, isWriteTool } from '../tool-filtering';
import { CORE_TOOL_NAMES } from '../stub-tools';
import { applyToolExposureMode } from '../../tools/tool-exposure';
import { TOOL_NAME_MAP } from '../../tools/tool-labels';
import { buildInlineInstructions } from '../inline-instructions';
import { buildSystemPrompt } from '../system-prompt';
import { BUILTIN_SKILLS, validateCommandDescription } from '@pagespace/lib/commands/command-core';

const SHEET_FORMAT_TOOLS = ['format_sheet', 'set_conditional_format'] as const;

type SearchResult = { tools: Array<{ name: string }> };
type ExecuteResult = { error?: string } | Record<string, unknown>;

const probe = async (tools: Record<string, Tool>, name: string): Promise<string[]> => {
  const search = tools.tool_search as Tool;
  const result = (await (search.execute as (a: unknown, o: unknown) => Promise<SearchResult>)(
    { query: `select:${name}` },
    {},
  )) as SearchResult;
  return result.tools.map((t) => t.name);
};

const dispatch = async (tools: Record<string, Tool>, name: string): Promise<ExecuteResult> => {
  const exec = tools.execute_tool as Tool;
  return (await (exec.execute as (a: unknown, o: unknown) => Promise<ExecuteResult>)(
    { tool_name: name, parameters: {} },
    { experimental_context: {} },
  )) as ExecuteResult;
};

describe('sheet formatting tools — registration', () => {
  it('TOOL_REGISTRY.sheetsFormat is exactly the two tools', () => {
    expect([...TOOL_REGISTRY.sheetsFormat].sort()).toEqual([...SHEET_FORMAT_TOOLS].sort());
  });

  it('both names are workspace tools on the code-exec-off build', () => {
    const base = buildPageSpaceTools({ codeExecutionEnabled: false });
    for (const name of SHEET_FORMAT_TOOLS) {
      expect(WORKSPACE_TOOL_NAMES).toContain(name);
      expect(base[name]).toBeDefined();
    }
  });

  it('both have a curated label', () => {
    expect(TOOL_NAME_MAP.format_sheet).toBe('Format Sheet');
    expect(TOOL_NAME_MAP.set_conditional_format).toBe('Conditional Formatting');
  });

  it('the spreadsheets skill is discoverable through format_sheet and its description names formatting', () => {
    const skill = BUILTIN_SKILLS.find((s) => s.trigger === 'spreadsheets')!;
    expect(skill.requiredTools).toContain('format_sheet');
    // The description is the model's only retrieval signal; these are the
    // words a person types.
    for (const word of ['format', 'dashboard', 'presentable']) {
      expect(skill.description.toLowerCase()).toContain(word);
    }
    expect(validateCommandDescription(skill.description)).toEqual({ valid: true });
  });
});

describe('sheet formatting tools — gating', () => {
  it('WRITE_TOOLS contains both names (direct)', () => {
    for (const name of SHEET_FORMAT_TOOLS) {
      expect(WRITE_TOOLS.has(name), name).toBe(true);
      expect(isWriteTool(name)).toBe(true);
    }
  });

  it('a read-only agent loses both, and keeps read_sheet', () => {
    const base = buildPageSpaceTools({ codeExecutionEnabled: false });
    const readOnly = filterToolsForReadOnly(base, true);
    for (const name of SHEET_FORMAT_TOOLS) {
      expect(readOnly[name], name).toBeUndefined();
    }
    expect(readOnly.read_sheet).toBeDefined();
  });

  it('neither is a core tool, so the search-mode key-set assertion would be vacuous', () => {
    // This is the premise of the probes below, pinned so that a future edit
    // making one of them core does not silently turn the probes into no-ops
    // of a different kind.
    for (const name of SHEET_FORMAT_TOOLS) {
      expect(CORE_TOOL_NAMES.has(name), name).toBe(false);
    }
  });

  it('search mode: tool_search finds both on a full agent and neither on a read-only agent', async () => {
    const base = buildPageSpaceTools({ codeExecutionEnabled: false });
    const full = applyToolExposureMode(base, 'search').tools as Record<string, Tool>;
    const readOnly = applyToolExposureMode(filterToolsForReadOnly(base, true), 'search').tools as Record<string, Tool>;

    for (const name of SHEET_FORMAT_TOOLS) {
      expect(await probe(full, name), `${name} on a full agent`).toEqual([name]);
      expect(await probe(readOnly, name), `${name} on a read-only agent`).toEqual([]);
    }
    // The probe itself is live: a core read tool is still found on the
    // read-only set, so an empty result above is the filter, not a dead probe.
    expect(await probe(readOnly, 'read_sheet')).toEqual(['read_sheet']);
  });

  it('search mode: execute_tool dispatches to both on a full agent and reports them unknown on a read-only agent', async () => {
    const base = buildPageSpaceTools({ codeExecutionEnabled: false });
    const full = applyToolExposureMode(base, 'search').tools as Record<string, Tool>;
    const readOnly = applyToolExposureMode(filterToolsForReadOnly(base, true), 'search').tools as Record<string, Tool>;

    for (const name of SHEET_FORMAT_TOOLS) {
      // On the full set the call REACHES the tool: with an empty context the
      // tool's own auth guard throws, which is a different failure from the
      // dispatcher's unknown-tool envelope.
      await expect(dispatch(full, name), `${name} on a full agent`).rejects.toThrow('User authentication required');

      const refused = await dispatch(readOnly, name);
      expect(refused.error, `${name} on a read-only agent`).toContain(`Unknown tool "${name}"`);
    }
  });
});

describe('sheet formatting tools — prompts', () => {
  const sheetLine = (tools: string[]) =>
    buildInlineInstructions(tools).split('\n').find((l) => l.startsWith('• SHEET')) ?? '';

  it('the SHEET bullet names format_sheet only to an agent that holds it', () => {
    expect(sheetLine(['read_sheet', 'edit_sheet_cells', 'format_sheet'])).toContain('format_sheet');
    expect(sheetLine(['read_sheet', 'edit_sheet_cells'])).not.toContain('format_sheet');
    expect(sheetLine(['format_sheet'])).toContain('format_sheet');
    expect(sheetLine([])).not.toContain('format_sheet');
  });

  it('a formatting tool does NOT make a Sheet a sandbox-output destination', () => {
    // SHEET_WRITE_TOOL_NAMES answers "can this agent put sandbox OUTPUT into
    // a Sheet". format_sheet cannot put data anywhere, so an agent holding
    // only it must not be told a Sheet is a valid destination.
    const result = buildSystemPrompt(false, undefined, true, ['read_page', 'bash', 'format_sheet', 'set_conditional_format']);
    expect(result).not.toContain('write meaningful output back into the drive');
    expect(result).not.toContain('(a Sheet)');
  });
});
