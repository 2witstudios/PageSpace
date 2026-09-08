/**
 * The spreadsheets skill teaches the formatting capability, and tells no lies
 * about the write paths.
 *
 * Before `format_sheet` was registered the body said `edit_sheet_cells` was
 * "the only write path" and pitfall 7 said to enter bare numbers and stop
 * there. Each case names one line the rewrite had to carry, so a future trim
 * against MAX_BODY_CHARS cannot quietly drop the capability it exists to teach.
 */
import { describe, it, expect } from 'vitest';
import { SPREADSHEETS_SKILL_BODY as body } from '../bodies/spreadsheets';
import { WORKSPACE_TOOL_NAMES } from '@/lib/ai/core/ai-tools';

/** Every backticked snake_case token — the way the body spells a tool name. */
const backtickedToolNames = (text: string): string[] => {
  const names = new Set<string>();
  for (const match of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
};

describe('spreadsheets skill body', () => {
  it('every tool name it mentions is a workspace tool', () => {
    const known = new Set(WORKSPACE_TOOL_NAMES);
    const mentioned = backtickedToolNames(body);
    // The extractor is live: it must at least see the four sheet tools.
    expect(mentioned).toEqual(expect.arrayContaining(['read_sheet', 'edit_sheet_cells', 'format_sheet', 'set_conditional_format']));
    const unknown = mentioned.filter((name) => !known.has(name));
    expect(unknown, `body names tools that do not exist: ${unknown.join(', ')}`).toEqual([]);
  });

  it('no longer claims edit_sheet_cells is the only write path', () => {
    const offending = body
      .split('\n')
      .filter((line) => /only write path/i.test(line) || /always use edit_sheet_cells/i.test(line));
    expect(offending).toEqual([]);
  });

  it('teaches regions before ops, with the lines the model cannot infer from the schema', () => {
    const regionsAt = body.indexOf('describe the table');
    const opsAt = body.indexOf('escape hatch');
    expect(regionsAt).toBeGreaterThan(0);
    expect(opsAt).toBeGreaterThan(regionsAt);

    expect(body).toContain('do NOT cover rows added later; regions do');
    expect(body).toContain('costs nothing per row');
    expect(body).toContain('4,999');
    expect(body).toContain("column default < region < the cell's own format < conditional rule");
    expect(body).toMatch(/computed, unformatted\*\* value: `"1200"`, never `"\$1,200\.00"`/);
  });

  it('carries a worked one-call budget example', () => {
    const example = body.slice(body.indexOf('format_sheet({'), body.indexOf('```', body.indexOf('format_sheet({')));
    expect(example).toContain('headerRows');
    expect(example).toContain('role: "currency"');
    expect(example).toContain('totalRows');
    expect(example).toContain('theme');
  });

  it('covers the four rule kinds and the replaceAll read-first rule', () => {
    for (const kind of ['`cell`', '`formula`', '`colorScale`', '`dataBar`']) {
      expect(body).toContain(kind);
    }
    const replaceAll = body.indexOf('`mode: "replaceAll"`');
    expect(replaceAll).toBeGreaterThan(0);
    expect(body.slice(replaceAll, replaceAll + 200)).toContain('includeFormatting: true');
  });

  it('pitfall 7 keeps raw values raw AND opens the door to display formatting', () => {
    const pitfall = body.split('\n').find((line) => line.startsWith('7. **Formatted numbers.**')) ?? '';
    expect(pitfall).toContain('Enter `1200` and `0.85`');
    expect(pitfall).toContain('format_sheet');
    expect(pitfall).toContain('`SUM` still works');
    expect(pitfall).toContain('`"1200"`');
  });

  it('names the two new pitfalls', () => {
    expect(body).toMatch(/^\d+\. \*\*Colouring cells instead of writing a rule\.\*\*/m);
    expect(body).toMatch(/^\d+\. \*\*Formatting a table cell-by-cell instead of declaring a region\.\*\*/m);
  });

  it('tells the reader about includeFormatting on read_sheet', () => {
    const readSection = body.slice(body.indexOf('## Reading a sheet'), body.indexOf('## Structuring a new sheet'));
    expect(readSection).toContain('`includeFormatting: true`');
  });
});
