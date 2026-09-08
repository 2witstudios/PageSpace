'use client';

import React, { memo } from 'react';
import { usePageNavigation } from '@/hooks/usePageNavigation';
import { Table2, ExternalLink, Paintbrush } from 'lucide-react';
import { normalizeHex, regionTheme } from '@pagespace/lib/sheets/sheet';
import { describeCondition } from '@/components/layout/middle-content/page-views/sheet/core/rule-presets';
import type { FormatOpInput, RegionInput, RuleInput } from '@/lib/ai/tools/sheet-format-tools';
import { cn } from '@/lib/utils';

/**
 * SheetFormatRenderer — what `format_sheet` / `set_conditional_format` did.
 *
 * Deliberately NOT `SheetEditRenderer`: that card is an address → VALUE table,
 * and a formatting call has no values. What a person wants to see here is the
 * shape of the change — which tables were declared and over what ranges, how
 * many escape-hatch ops ran, which rules were added or removed — plus a swatch
 * per distinct colour so a "make it green" request is visibly green without
 * opening the sheet. Reads the tool INPUT for the structure (the result only
 * carries counts and ids) and the OUTPUT for what actually landed.
 *
 * The input is the model's, validated by the tool only on the success path
 * the registry guards for; every deref below tolerates a missing field so a
 * malformed call can never take the message list down.
 */

interface SheetFormatRendererProps {
  title?: string;
  pageId?: string;
  regions?: RegionInput[];
  /** `replaceAll` removed every region on the tab that is not in `regions`. */
  regionMode?: 'merge' | 'replaceAll';
  ops?: FormatOpInput[];
  rules?: RuleInput[];
  /** From the result: rule ids the store confirmed it removed under its lock. */
  removedRuleIds?: string[];
  /** From the result: the ids the call's rules landed under, by index. */
  ruleIds?: string[];
  /** From the result: which of those ids were NEW on the tab. */
  ruleIdsAdded?: string[];
  ruleMode?: 'append' | 'replaceAll';
  /** From the result: what landed, when it differs from what was asked. */
  regionsApplied?: number;
  opsApplied?: number;
  cellsFormatted?: number;
  rulesAdded?: number;
  rulesRemoved?: number;
  /**
   * From the result: rules in the call that were already on the tab, by index
   * into `rules`. A retried append reports every rule here with `added: 0`;
   * without this the card would present them as changes that never landed.
   */
  skippedDuplicates?: Array<{ index: number }>;
  /** From the result: false when the sheet already looked like this and nothing was written. */
  changed?: boolean;
  message?: string;
}

const NONE: never[] = [];
const ROW = 'flex items-center gap-3 px-3 py-1.5 text-sm';

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The colour the sheet actually paints for this region's header band — the
 * same resolution `region-format` uses, slate fallback included — so the
 * swatch can never drift from the sheet.
 */
const regionSwatch = (theme: string | undefined): { colour: string; name: string } => {
  const { hue, header } = regionTheme(theme);
  return { colour: header.background ?? hue.deep, name: hue.name };
};

const isColour = (value: string | undefined): value is string => Boolean(value);

const opColours = (op: FormatOpInput): string[] =>
  [op.format?.background, op.format?.color].filter(isColour);

const ruleColours = (rule: RuleInput): string[] =>
  [rule.format?.background, rule.format?.color, rule.min?.color, rule.mid?.color, rule.max?.color, rule.color].filter(isColour);

/** The target an op touched, in the words the op used. */
const describeOpTarget = (op: FormatOpInput): string => {
  if (op.op === 'freeze') {
    if (op.clear) return 'unfreeze';
    const parts: string[] = [];
    if (op.frozenRows !== undefined) parts.push(count(op.frozenRows, 'row'));
    if (op.frozenColumns !== undefined) parts.push(count(op.frozenColumns, 'col'));
    return parts.join(', ') || 'freeze';
  }
  if (op.range) return op.range.toUpperCase();
  if (op.column) {
    const suffix = op.width !== undefined ? ` ${op.width}px` : op.clear ? ' reset' : '';
    return `column ${op.column.toUpperCase()}${suffix}`;
  }
  if (op.row !== undefined) {
    const suffix = op.height !== undefined ? ` ${op.height}px` : op.clear ? ' reset' : '';
    return `row ${op.row}${suffix}`;
  }
  return '';
};

const operand = (value: string | number | undefined): string | undefined =>
  value === undefined ? undefined : String(value);

/**
 * One line per rule, in the sheet's own words. `describeCondition` is what the
 * rule panel uses, and it already omits the operands the executor drops — none
 * for isEmpty/isNotEmpty/isError, no `value2` outside between/notBetween — so
 * the card describes the rule that was stored, not the raw input.
 */
const describeRule = (rule: RuleInput): string => {
  const ranges = (rule.ranges ?? []).map((r) => r.toUpperCase()).join(', ');
  switch (rule.kind) {
    case 'cell':
      return rule.operator
        ? `${ranges} · ${describeCondition({ operator: rule.operator, value: operand(rule.value), value2: operand(rule.value2) })}`
        : ranges;
    case 'formula':
      return `${ranges} · ${rule.formula ?? 'formula'}`;
    case 'colorScale':
      return `${ranges} · colour scale`;
    case 'dataBar':
      return `${ranges} · data bar`;
    default:
      return ranges;
  }
};

/** Every distinct colour the call named, normalised so `#FFF` and `#ffffff` are one swatch. */
const collectColours = (regions: RegionInput[], ops: FormatOpInput[], rules: RuleInput[]): string[] => {
  const named = [
    ...regions.map((region) => regionSwatch(region.theme).colour),
    ...ops.flatMap(opColours),
    ...rules.flatMap(ruleColours),
  ];
  return [...new Set(named.map((value) => normalizeHex(value) ?? value))];
};

const Swatch: React.FC<{ colour: string; label?: string }> = ({ colour, label }) => (
  <span
    className="inline-block h-3 w-3 rounded-sm border border-border/60 shrink-0"
    style={{ backgroundColor: colour }}
    title={label ?? colour}
    aria-label={label ?? colour}
  />
);

const Swatches: React.FC<{ colours: string[] }> = ({ colours }) => (
  <span className="flex items-center gap-1 shrink-0">
    {colours.map((colour, i) => (
      <Swatch key={`${colour}-${i}`} colour={colour} />
    ))}
  </span>
);

export const SheetFormatRenderer: React.FC<SheetFormatRendererProps> = memo(function SheetFormatRenderer({
  title = 'Sheet',
  pageId,
  regions = NONE,
  regionMode,
  ops = NONE,
  rules = NONE,
  removedRuleIds = NONE,
  ruleIds = NONE,
  ruleIdsAdded = NONE,
  ruleMode,
  regionsApplied,
  opsApplied,
  cellsFormatted,
  rulesAdded,
  rulesRemoved,
  skippedDuplicates = NONE,
  changed,
  message,
}) {
  const { navigateToPage } = usePageNavigation();
  const colours = collectColours(regions, ops, rules);
  // The executor removes a repeated id once; the card must not list it twice.
  const removedIds = [...new Set(removedRuleIds)];
  const duplicateIndexes = new Set(skippedDuplicates.map((entry) => entry.index));

  const regionCount = regionsApplied ?? regions.length;
  const opCount = opsApplied ?? ops.length;
  const added = rulesAdded ?? 0;
  const removed = rulesRemoved ?? removedIds.length;
  // A replaceAll that neither added nor removed but did write reordered the
  // rules — a real, precedence-changing change with no row to show for it.
  const reordered = ruleMode === 'replaceAll' && changed === true && added === 0 && removed === 0 && rules.length > 0;
  const addedIds = new Set(ruleIdsAdded);
  const replacedAll = regionMode === 'replaceAll';
  const summary = [
    ...(regionCount > 0 ? [count(regionCount, 'region')] : []),
    ...(replacedAll ? ['other regions removed'] : []),
    ...(opCount > 0 ? [count(opCount, 'op')] : []),
    ...(cellsFormatted ? [count(cellsFormatted, 'cell')] : []),
    ...(added > 0 ? [`${count(added, 'rule')} added`] : []),
    ...(reordered ? ['rules reordered'] : []),
    ...(ruleMode === 'replaceAll' && !reordered && rules.length - added > 0 ? [`${rules.length - added} kept`] : []),
    ...(duplicateIndexes.size > 0 ? [`${duplicateIndexes.size} already present`] : []),
    ...(removed > 0 ? [`${removed} removed`] : []),
  ].join(' · ');

  // A call the store reports as a no-op is shown as one, not as the list of
  // formatting it would have applied — that formatting was already there.
  const unchanged = changed === false;
  const empty = unchanged || (regions.length === 0 && ops.length === 0 && rules.length === 0 && removedIds.length === 0 && !replacedAll);

  return (
    <div className="rounded-lg border bg-card overflow-hidden my-2 shadow-sm">
      <button
        type="button"
        onClick={() => pageId && navigateToPage(pageId)}
        disabled={!pageId}
        className={cn(
          'w-full flex items-center justify-between px-3 py-2 bg-muted/30 border-b text-left',
          'hover:bg-muted/50 transition-colors',
          !pageId && 'cursor-default'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Table2 className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate" title={title}>
            {title}
          </span>
        </div>
        <span className="flex items-center gap-2 shrink-0">
          {colours.length > 0 && (
            <span data-testid="sheet-format-swatches">
              <Swatches colours={colours} />
            </span>
          )}
          {unchanged ? (
            <span className="text-xs text-muted-foreground">already formatted this way</span>
          ) : (
            summary && <span className="text-xs text-muted-foreground">{summary}</span>
          )}
          {pageId && <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />}
        </span>
      </button>

      <div className="bg-background overflow-auto divide-y divide-border max-h-[280px]">
        {empty ? (
          <div className="text-sm text-muted-foreground text-center py-4" data-testid="sheet-format-empty">
            {unchanged ? 'Nothing changed — the sheet already had this formatting.' : (message ?? 'Nothing changed')}
          </div>
        ) : (
          <>
            {regions.map((region, i) => {
              const swatch = regionSwatch(region.theme);
              const details = [
                ...(region.headerRows !== undefined && region.headerRows !== 1 ? [count(region.headerRows, 'header row')] : []),
                ...(region.columns ?? []).map(
                  (column) => `${column.column.toUpperCase()} ${column.role}${column.currency ? ` ${column.currency}` : ''}`
                ),
                ...(region.totalRows && region.totalRows.length > 0 ? [`total ${region.totalRows.join(', ')}`] : []),
                ...(region.freezeHeader ? ['frozen header'] : []),
              ];
              return (
                <div key={`region-${i}`} className={ROW} data-testid="sheet-format-region">
                  <code className="w-14 shrink-0 font-mono text-xs text-muted-foreground">{(region.range ?? '').toUpperCase()}</code>
                  <span className="flex-1 min-w-0 truncate text-xs">
                    <span className="font-medium">{region.name ?? 'Table'}</span>
                    {details.length > 0 && <span className="text-muted-foreground"> · {details.join(' · ')}</span>}
                  </span>
                  <span className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded shrink-0 bg-muted text-muted-foreground">
                    <Swatch colour={swatch.colour} label={swatch.name} />
                    region
                  </span>
                </div>
              );
            })}
            {replacedAll && (
              <div className={cn(ROW, 'text-muted-foreground')} data-testid="sheet-format-regions-replaced">
                <Table2 className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 min-w-0 truncate text-xs">
                  {regions.length === 0 ? 'Every region on the tab removed' : 'Every other region on the tab removed'}
                </span>
                <span className="text-[11px] shrink-0">replaceAll</span>
              </div>
            )}
            {ops.map((op, i) => (
              <div key={`op-${i}`} className={ROW} data-testid="sheet-format-op">
                <code className="w-14 shrink-0 font-mono text-xs text-muted-foreground truncate">{describeOpTarget(op)}</code>
                <span className="flex-1 min-w-0 truncate font-mono text-xs">{op.op}</span>
                <Swatches colours={opColours(op)} />
              </div>
            ))}
            {rules.map((rule, i) => {
              // In append mode a rule the tab already held is "already
              // present" (skipped). In replaceAll every rule in the call is
              // on the tab afterwards; the ones that were there before are
              // "kept", which is not a skip — their order may have changed.
              const duplicate = duplicateIndexes.has(i);
              const kept = ruleMode === 'replaceAll' && ruleIds[i] !== undefined && !addedIds.has(ruleIds[i]);
              const badge = duplicate ? 'already present' : kept ? 'kept' : undefined;
              return (
                <div
                  key={`rule-${i}`}
                  className={cn(ROW, badge && 'text-muted-foreground')}
                  data-testid={duplicate ? 'sheet-format-rule-duplicate' : kept ? 'sheet-format-rule-kept' : 'sheet-format-rule'}
                >
                  <Paintbrush className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="flex-1 min-w-0 truncate font-mono text-xs">{describeRule(rule)}</span>
                  <Swatches colours={ruleColours(rule)} />
                  {badge && <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted shrink-0">{badge}</span>}
                </div>
              );
            })}
            {removedIds.map((id) => (
              <div key={`removed-${id}`} className={cn(ROW, 'text-muted-foreground')} data-testid="sheet-format-removed">
                <Paintbrush className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 min-w-0 truncate font-mono text-xs line-through">{id}</span>
                <span className="text-[11px] shrink-0">removed</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
});
