/**
 * The spreadsheets skill teaches the formatting capability, and tells no lies
 * about the write paths.
 *
 * Before `format_sheet` was registered the body said `edit_sheet_cells` was
 * "the only write path" and pitfall 7 said to enter bare numbers and stop
 * there. Each case pins a FACT the rewrite had to carry — not its wording, so
 * the body stays free to be trimmed against MAX_BODY_CHARS — and the last
 * two pin the claims the tool schema cannot convey and the tool would refuse.
 */
import { describe, it, expect } from 'vitest';
import { SPREADSHEETS_SKILL_BODY as body } from '../bodies/spreadsheets';

const section = (from: string, to: string) => body.slice(body.indexOf(from), body.indexOf(to));

describe('spreadsheets skill body', () => {
  it('no longer claims edit_sheet_cells is the only write path', () => {
    expect(body).not.toMatch(/only write path|always use edit_sheet_cells/i);
    expect(body).toContain('`format_sheet`');
    expect(body).toContain('`set_conditional_format`');
  });

  it('teaches regions before ops, with the lines the model cannot infer from the schema', () => {
    const formatting = section('## Formatting', '## Common pitfalls');
    expect(formatting.indexOf('regions')).toBeLessThan(formatting.indexOf('escape hatch'));
    expect(formatting).toMatch(/do NOT cover rows added later; regions do/);
    expect(formatting).toContain('4,999');
    expect(formatting).toMatch(/column default < region < .* < conditional rule/);
    expect(formatting).toMatch(/computed, unformatted\*\* value/);
    expect(formatting).toContain('format_sheet({');
  });

  it('covers the four rule kinds, requires the data-bar colour, and reads before replaceAll', () => {
    const rules = section('### Conditional formatting', '## Common pitfalls');
    for (const kind of ['`cell`', '`formula`', '`colorScale`', '`dataBar`']) {
      expect(rules).toContain(kind);
    }
    // buildRule refuses a dataBar without `color` (all-or-nothing), so the
    // body must not call it optional.
    expect(rules).toMatch(/`dataBar`[^\n]*`color` is required/);
    expect(rules).not.toMatch(/optional `color`/);
    const replaceAll = rules.indexOf('`mode: "replaceAll"`');
    expect(replaceAll).toBeGreaterThan(0);
    expect(rules.slice(replaceAll, replaceAll + 200)).toContain('includeFormatting: true');
  });

  it('pitfall 7 keeps raw values raw AND opens the door to display formatting', () => {
    const pitfall = body.split('\n').find((line) => line.startsWith('7. **Formatted numbers.**')) ?? '';
    expect(pitfall).toContain('Enter `1200` and `0.85`');
    expect(pitfall).toContain('format_sheet');
    expect(pitfall).toMatch(/`SUM` still works/);
  });

  it('names the two new pitfalls', () => {
    expect(body).toMatch(/^\d+\. \*\*Colouring cells instead of writing a rule\.\*\*/m);
    expect(body).toMatch(/^\d+\. \*\*Formatting a table cell-by-cell instead of declaring a region\.\*\*/m);
  });

  it('keeps the never-computed-formula exception on unformatted reads', () => {
    // sheet-view emits `unformatted` only for computed cells; a legacy formula
    // cell that was never evaluated returns the formula TEXT in `cells`. The
    // rewrite dropped this clause once (review), and a model without it
    // treats "=SUM(B2:B10)" as the value.
    expect(section('## Reading a sheet', '## Structuring a new sheet')).toMatch(/never computed[^\n]*`cells` holds the formula text/);
  });

  it('warns that MIN/MAX error on text like SUM does', () => {
    expect(body).toMatch(/`SUM`\/`MIN`\/`MAX` range errors/);
  });
});
