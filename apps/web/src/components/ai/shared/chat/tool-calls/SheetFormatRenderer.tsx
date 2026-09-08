'use client';

import React, { memo, useMemo } from 'react';
import { usePageNavigation } from '@/hooks/usePageNavigation';
import { Table2, ExternalLink, Paintbrush } from 'lucide-react';
import { PALETTE, normalizeHex } from '@pagespace/lib/sheets/sheet';
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
 */

export interface SheetFormatRegionInput {
  id?: string;
  name?: string;
  range: string;
  headerRows?: number;
  totalRows?: number[];
  columns?: Array<{ column: string; role: string; currency?: string }>;
  theme?: string;
  freezeHeader?: boolean;
}

interface FormatLike {
  color?: string;
  background?: string;
}

export interface SheetFormatOpInput {
  op: string;
  range?: string;
  column?: string;
  row?: number;
  format?: FormatLike;
  width?: number;
  height?: number;
  frozenRows?: number;
  frozenColumns?: number;
  clear?: true;
}

export interface SheetRuleInput {
  kind: string;
  ranges: string[];
  operator?: string;
  value?: string | number;
  value2?: string | number;
  formula?: string;
  format?: FormatLike;
  min?: { color?: string };
  mid?: { color?: string };
  max?: { color?: string };
  color?: string;
}

interface SheetFormatRendererProps {
  title?: string;
  pageId?: string;
  driveId?: string;
  regions?: SheetFormatRegionInput[];
  ops?: SheetFormatOpInput[];
  rules?: SheetRuleInput[];
  /** From the result: what landed, when it differs from what was asked. */
  opsApplied?: number;
  regionsApplied?: number;
  cellsFormatted?: number;
  rulesAdded?: number;
  rulesRemoved?: number;
  /**
   * From the result: rules in the call that were already on the tab, by index
   * into `rules`. A retried append reports every rule here with `added: 0`;
   * without this the card would present them as changes that never landed.
   */
  skippedDuplicates?: Array<{ index: number; existingRuleId: string }>;
  removedRuleIds?: string[];
  message?: string;
  maxHeight?: number;
  className?: string;
}

const themeSwatch = (theme: string | undefined): string | null => {
  if (!theme) return null;
  const hue = PALETTE.find((entry) => entry.name === theme);
  return hue ? hue.mid : null;
};

/** The target an op touched, in the words the op used. */
const describeOpTarget = (op: SheetFormatOpInput): string => {
  if (op.op === 'freeze') {
    if (op.clear) return 'unfreeze';
    const parts: string[] = [];
    if (op.frozenRows !== undefined) parts.push(`${op.frozenRows} row${op.frozenRows === 1 ? '' : 's'}`);
    if (op.frozenColumns !== undefined) parts.push(`${op.frozenColumns} col${op.frozenColumns === 1 ? '' : 's'}`);
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

const describeRule = (rule: SheetRuleInput): string => {
  const ranges = rule.ranges.map((r) => r.toUpperCase()).join(', ');
  switch (rule.kind) {
    case 'cell': {
      const operand = rule.value !== undefined ? ` ${String(rule.value)}` : '';
      const upper = rule.value2 !== undefined ? ` and ${String(rule.value2)}` : '';
      return `${ranges} · ${rule.operator ?? 'cell'}${operand}${upper}`;
    }
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
const collectColours = (ops: SheetFormatOpInput[], rules: SheetRuleInput[], regions: SheetFormatRegionInput[]): string[] => {
  const seen = new Set<string>();
  const add = (value: string | undefined | null) => {
    if (!value) return;
    const hex = normalizeHex(value) ?? value;
    seen.add(hex);
  };
  for (const region of regions) add(themeSwatch(region.theme));
  for (const op of ops) {
    add(op.format?.color);
    add(op.format?.background);
  }
  for (const rule of rules) {
    add(rule.format?.color);
    add(rule.format?.background);
    add(rule.min?.color);
    add(rule.mid?.color);
    add(rule.max?.color);
    add(rule.color);
  }
  return [...seen];
};

const Swatch: React.FC<{ colour: string; label?: string }> = ({ colour, label }) => (
  <span
    className="inline-block h-3 w-3 rounded-sm border border-border/60 shrink-0"
    style={{ backgroundColor: colour }}
    title={label ?? colour}
    aria-label={label ?? colour}
  />
);

export const SheetFormatRenderer: React.FC<SheetFormatRendererProps> = memo(function SheetFormatRenderer({
  title = 'Sheet',
  pageId,
  driveId,
  regions = [],
  ops = [],
  rules = [],
  opsApplied,
  regionsApplied,
  cellsFormatted,
  rulesAdded,
  rulesRemoved,
  skippedDuplicates = [],
  removedRuleIds = [],
  message,
  maxHeight = 280,
  className,
}) {
  const { navigateToPage } = usePageNavigation();
  const colours = useMemo(() => collectColours(ops, rules, regions), [ops, rules, regions]);
  const duplicateIndexes = useMemo(() => new Set(skippedDuplicates.map((entry) => entry.index)), [skippedDuplicates]);

  const summary = useMemo(() => {
    const parts: string[] = [];
    const regionCount = regionsApplied ?? regions.length;
    const opCount = opsApplied ?? ops.length;
    const added = rulesAdded ?? rules.length - duplicateIndexes.size;
    const removed = rulesRemoved ?? removedRuleIds.length;
    if (regionCount > 0) parts.push(`${regionCount} ${regionCount === 1 ? 'region' : 'regions'}`);
    if (opCount > 0) parts.push(`${opCount} ${opCount === 1 ? 'op' : 'ops'}`);
    if (cellsFormatted) parts.push(`${cellsFormatted} ${cellsFormatted === 1 ? 'cell' : 'cells'}`);
    if (added > 0) parts.push(`${added} ${added === 1 ? 'rule' : 'rules'} added`);
    if (duplicateIndexes.size > 0) parts.push(`${duplicateIndexes.size} already present`);
    if (removed > 0) parts.push(`${removed} removed`);
    return parts.join(' · ');
  }, [regionsApplied, regions.length, opsApplied, ops.length, cellsFormatted, rulesAdded, rules.length, duplicateIndexes, rulesRemoved, removedRuleIds.length]);

  const empty = regions.length === 0 && ops.length === 0 && rules.length === 0 && removedRuleIds.length === 0;

  return (
    <div className={cn('rounded-lg border bg-card overflow-hidden my-2 shadow-sm', className)}>
      <button
        type="button"
        onClick={() => pageId && navigateToPage(pageId, driveId)}
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
            <span className="flex items-center gap-1" data-testid="sheet-format-swatches">
              {colours.map((colour) => (
                <Swatch key={colour} colour={colour} />
              ))}
            </span>
          )}
          {summary && <span className="text-xs text-muted-foreground">{summary}</span>}
          {pageId && <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />}
        </span>
      </button>

      <div className="bg-background overflow-auto divide-y divide-border" style={{ maxHeight: `${maxHeight}px` }}>
        {empty ? (
          <div className="text-sm text-muted-foreground text-center py-4">{message ?? 'Nothing changed'}</div>
        ) : (
          <>
            {regions.map((region, i) => {
              const swatch = themeSwatch(region.theme);
              const details: string[] = [];
              if (region.headerRows !== undefined && region.headerRows !== 1) details.push(`${region.headerRows} header rows`);
              for (const column of region.columns ?? []) {
                details.push(`${column.column.toUpperCase()} ${column.role}${column.currency ? ` ${column.currency}` : ''}`);
              }
              if (region.totalRows && region.totalRows.length > 0) details.push(`total ${region.totalRows.join(', ')}`);
              if (region.freezeHeader) details.push('frozen header');
              return (
                <div key={`region-${i}`} className="flex items-center gap-3 px-3 py-1.5 text-sm" data-testid="sheet-format-region">
                  <code className="w-14 shrink-0 font-mono text-xs text-muted-foreground">{region.range.toUpperCase()}</code>
                  <span className="flex-1 min-w-0 truncate text-xs">
                    <span className="font-medium">{region.name ?? 'Table'}</span>
                    {details.length > 0 && <span className="text-muted-foreground"> · {details.join(' · ')}</span>}
                  </span>
                  <span className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded shrink-0 bg-muted text-muted-foreground">
                    {swatch && <Swatch colour={swatch} label={region.theme} />}
                    region
                  </span>
                </div>
              );
            })}
            {ops.map((op, i) => (
              <div key={`op-${i}`} className="flex items-center gap-3 px-3 py-1.5 text-sm" data-testid="sheet-format-op">
                <code className="w-14 shrink-0 font-mono text-xs text-muted-foreground truncate">{describeOpTarget(op)}</code>
                <span className="flex-1 min-w-0 truncate font-mono text-xs">{op.op}</span>
                <span className="flex items-center gap-1 shrink-0">
                  {op.format?.background && <Swatch colour={op.format.background} />}
                  {op.format?.color && <Swatch colour={op.format.color} />}
                </span>
              </div>
            ))}
            {rules.map((rule, i) => {
              const duplicate = duplicateIndexes.has(i);
              return (
                <div
                  key={`rule-${i}`}
                  className={cn('flex items-center gap-3 px-3 py-1.5 text-sm', duplicate && 'text-muted-foreground')}
                  data-testid={duplicate ? 'sheet-format-rule-duplicate' : 'sheet-format-rule'}
                >
                  <Paintbrush className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="flex-1 min-w-0 truncate font-mono text-xs">{describeRule(rule)}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {[rule.format?.background, rule.format?.color, rule.min?.color, rule.mid?.color, rule.max?.color, rule.color]
                      .filter((c): c is string => Boolean(c))
                      .map((c, j) => <Swatch key={`${c}-${j}`} colour={c} />)}
                    {duplicate && <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted">already present</span>}
                  </span>
                </div>
              );
            })}
            {removedRuleIds.map((id) => (
              <div key={`removed-${id}`} className="flex items-center gap-3 px-3 py-1.5 text-sm text-muted-foreground" data-testid="sheet-format-removed">
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
