"use client";

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Plus, Trash2, X } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ConditionalRule } from '@pagespace/lib/sheets/sheet';
import { SheetColorPicker } from './SheetColorPicker';
import {
  KIND_LABELS,
  OPERATOR_LABELS,
  RANGE_OPERATORS,
  VALUELESS_OPERATORS,
  describeRule,
  type RuleKind,
} from '../core/rule-presets';

export interface SheetConditionalPanelProps {
  rules: readonly ConditionalRule[];
  /** The range a new rule defaults to — whatever is selected in the grid. */
  defaultRange: string;
  disabled: boolean;
  /** Set when the last attempt was refused, e.g. past a ceiling. */
  refusal: string | null;
  /**
   * Bumped on every refusal. A refused edit leaves the rule unchanged, so a key
   * derived from the rule alone would not remount the field, and it would go on
   * showing the rejected text — and reapply it on the next blur.
   */
  resetToken: number;
  onAdd: (kind: RuleKind, ranges: string[]) => void;
  onUpdate: (id: string, patch: Partial<ConditionalRule>) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onClose: () => void;
}

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="flex flex-col gap-1">
    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
    {children}
  </label>
);

/** Ranges are edited as the comma-separated list people already write. */
const rangesToText = (ranges: readonly string[]): string => ranges.join(', ');
const textToRanges = (text: string): string[] =>
  text.split(',').map((part) => part.trim()).filter((part) => part !== '');

/**
 * Text fields commit on blur rather than per keystroke, because half-typed
 * "B2:B" is not a range and rejecting it mid-word would fight the person
 * typing. That means they are uncontrolled — and an uncontrolled input keeps
 * its own DOM value, so after an undo, a redo, or a refused edit it would go on
 * showing a value the rule does not have, and merely focusing and blurring it
 * would reapply that stale value.
 *
 * Keying each field on the value it is editing remounts it whenever the rule
 * changes underneath, which resynchronises without taking the on-blur commit
 * away.
 */
const RuleEditor: React.FC<{
  rule: ConditionalRule;
  disabled: boolean;
  resetToken: number;
  onUpdate: (patch: Partial<ConditionalRule>) => void;
}> = ({ rule, disabled, resetToken, onUpdate }) => (
  <div className="flex flex-col gap-3 border-t border-[var(--separator)] px-3 py-3">
    <Field label="Applies to">
      <Input
        key={`ranges:${resetToken}:${rangesToText(rule.ranges)}`}
        defaultValue={rangesToText(rule.ranges)}
        onBlur={(event) => onUpdate({ ranges: textToRanges(event.target.value) })}
        disabled={disabled}
        className="h-8 font-mono text-xs"
        placeholder="B2:B20, D2:D20"
        aria-label="Ranges this rule applies to"
      />
    </Field>

    {rule.kind === 'cell' && (
      <>
        <Field label="When the cell">
          <Select
            value={rule.condition.operator}
            onValueChange={(operator) =>
              onUpdate({
                condition: { ...rule.condition, operator: operator as never },
              } as Partial<ConditionalRule>)
            }
            disabled={disabled}
          >
            <SelectTrigger className="h-8 text-xs" aria-label="Condition">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OPERATOR_LABELS.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {!VALUELESS_OPERATORS.has(rule.condition.operator) && (
          <div className="flex gap-2">
            <Field label="Value">
              <Input
                key={`value:${resetToken}:${rule.condition.value ?? ''}`}
                defaultValue={rule.condition.value ?? ''}
                onBlur={(event) =>
                  onUpdate({
                    condition: { ...rule.condition, value: event.target.value },
                  } as Partial<ConditionalRule>)
                }
                disabled={disabled}
                className="h-8 text-xs"
                aria-label="Comparison value"
              />
            </Field>
            {RANGE_OPERATORS.has(rule.condition.operator) && (
              <Field label="And">
                <Input
                  key={`value2:${resetToken}:${rule.condition.value2 ?? ''}`}
                  defaultValue={rule.condition.value2 ?? ''}
                  onBlur={(event) =>
                    onUpdate({
                      condition: { ...rule.condition, value2: event.target.value },
                    } as Partial<ConditionalRule>)
                  }
                  disabled={disabled}
                  className="h-8 text-xs"
                  aria-label="Upper bound"
                />
              </Field>
            )}
          </div>
        )}
      </>
    )}

    {rule.kind === 'formula' && (
      <Field label="Formula is true">
        <Input
          key={`formula:${resetToken}:${rule.formula}`}
          defaultValue={rule.formula}
          onBlur={(event) => onUpdate({ formula: event.target.value } as Partial<ConditionalRule>)}
          disabled={disabled}
          className="h-8 font-mono text-xs"
          placeholder="=B2>SUM(C2:C9)"
          aria-label="Formula"
        />
      </Field>
    )}

    {(rule.kind === 'cell' || rule.kind === 'formula') && (
      <div className="flex items-end gap-2">
        <SheetColorPicker
          value={rule.format.background}
          onChange={(color) =>
            onUpdate({ format: { ...rule.format, background: color } } as Partial<ConditionalRule>)
          }
          icon={<span className="text-xs">Fill</span>}
          label="Rule fill colour"
          disabled={disabled}
        />
        <SheetColorPicker
          value={rule.format.color}
          onChange={(color) =>
            onUpdate({ format: { ...rule.format, color } } as Partial<ConditionalRule>)
          }
          icon={<span className="text-xs">Text</span>}
          label="Rule text colour"
          disabled={disabled}
        />
        <Button
          type="button"
          variant={rule.format.bold ? 'default' : 'outline'}
          size="sm"
          className="h-8"
          disabled={disabled}
          aria-pressed={!!rule.format.bold}
          onClick={() =>
            onUpdate({
              format: { ...rule.format, bold: rule.format.bold ? undefined : true },
            } as Partial<ConditionalRule>)
          }
        >
          Bold
        </Button>
      </div>
    )}

    {rule.kind === 'colorScale' && (
      <div className="flex items-end gap-2">
        <SheetColorPicker
          value={rule.min.color}
          onChange={(color) =>
            onUpdate({ min: { ...rule.min, color: color ?? '#ffffff' } } as Partial<ConditionalRule>)
          }
          icon={<span className="text-xs">Min</span>}
          label="Scale minimum colour"
          disabled={disabled}
        />
        <SheetColorPicker
          value={rule.max.color}
          onChange={(color) =>
            onUpdate({ max: { ...rule.max, color: color ?? '#22c55e' } } as Partial<ConditionalRule>)
          }
          icon={<span className="text-xs">Max</span>}
          label="Scale maximum colour"
          disabled={disabled}
        />
      </div>
    )}

    {rule.kind === 'dataBar' && (
      <SheetColorPicker
        value={rule.color}
        onChange={(color) => onUpdate({ color: color ?? '#3b82f6' } as Partial<ConditionalRule>)}
        icon={<span className="text-xs">Bar</span>}
        label="Data bar colour"
        disabled={disabled}
      />
    )}
  </div>
);

/**
 * The conditional-formatting rules panel.
 *
 * Rules are listed in application order, because that order is what decides
 * which one wins — a later rule layers over an earlier one — so the reorder
 * controls are the point of the list rather than a convenience.
 */
export const SheetConditionalPanel: React.FC<SheetConditionalPanelProps> = ({
  rules,
  defaultRange,
  disabled,
  refusal,
  resetToken,
  onAdd,
  onUpdate,
  onRemove,
  onMove,
  onClose,
}) => {
  const [openId, setOpenId] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<RuleKind>('cell');

  return (
    <aside
      aria-label="Conditional formatting"
      className="flex h-full w-[320px] shrink-0 flex-col border-l border-[var(--separator)] bg-background"
    >
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-sm font-medium">Conditional formatting</h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close" className="h-7 w-7 p-0">
          <X size={16} />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rules.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No rules yet. Add one to colour cells by what they contain.
          </p>
        )}

        {rules.map((rule, index) => (
          <div key={rule.id} className="border-b border-[var(--separator)]">
            <div className="flex items-center gap-1 px-3 py-2">
              <button
                type="button"
                onClick={() => setOpenId(openId === rule.id ? null : rule.id)}
                className="flex-1 truncate text-left text-xs"
                aria-expanded={openId === rule.id}
                // Named explicitly: the row's visible text is also carried by
                // the Move and Delete labels, so without this a screen reader
                // hears three controls with near-identical names.
                aria-label={`Edit rule: ${describeRule(rule)}`}
              >
                <span className="font-medium">{describeRule(rule)}</span>
                <span className="ml-1 font-mono text-muted-foreground">
                  {rangesToText(rule.ranges)}
                </span>
              </button>
              <Button
                variant="ghost" size="sm" className="h-7 w-7 p-0"
                disabled={disabled || index === 0}
                onClick={() => onMove(rule.id, -1)}
                aria-label={`Move ${describeRule(rule)} earlier`}
              >
                <ChevronUp size={14} />
              </Button>
              <Button
                variant="ghost" size="sm" className="h-7 w-7 p-0"
                disabled={disabled || index === rules.length - 1}
                onClick={() => onMove(rule.id, 1)}
                aria-label={`Move ${describeRule(rule)} later`}
              >
                <ChevronDown size={14} />
              </Button>
              <Button
                variant="ghost" size="sm"
                className="h-7 w-7 p-0 text-destructive"
                disabled={disabled}
                onClick={() => onRemove(rule.id)}
                aria-label={`Delete ${describeRule(rule)}`}
              >
                <Trash2 size={14} />
              </Button>
            </div>
            {openId === rule.id && (
              <RuleEditor
                rule={rule}
                disabled={disabled}
                resetToken={resetToken}
                onUpdate={(patch) => onUpdate(rule.id, patch)}
              />
            )}
          </div>
        ))}
      </div>

      <footer className="flex flex-col gap-2 border-t border-[var(--separator)] px-3 py-2">
        {refusal && (
          <p role="alert" className="text-xs text-destructive">
            {refusal}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Select value={newKind} onValueChange={(value) => setNewKind(value as RuleKind)} disabled={disabled}>
            <SelectTrigger className="h-8 flex-1 text-xs" aria-label="New rule type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_LABELS.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="h-8"
            disabled={disabled}
            onClick={() => onAdd(newKind, [defaultRange])}
          >
            <Plus size={14} className="mr-1" />
            Add
          </Button>
        </div>
        <p className={cn('text-[11px] text-muted-foreground')}>
          Applies to <span className="font-mono">{defaultRange}</span>. Later rules layer over
          earlier ones.
        </p>
      </footer>
    </aside>
  );
};
