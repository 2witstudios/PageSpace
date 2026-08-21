"use client";

import React from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  Calendar,
  DollarSign,
  Eraser,
  Hash,
  Italic,
  PaintBucket,
  Percent,
  Redo2,
  Snowflake,
  Strikethrough,
  Underline,
  Undo2,
  WrapText,
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { CellFormat, NumberFormatKind } from '@pagespace/lib/sheets/sheet';
import type { FormatCommand } from '../core/format-commands';
import { SheetColorPicker } from './SheetColorPicker';

const FONT_SIZES = [10, 11, 12, 14, 16, 18, 20, 24, 32] as const;

const NUMBER_FORMATS: Array<{ kind: NumberFormatKind; label: string; hint?: string }> = [
  { kind: 'auto', label: 'Automatic' },
  { kind: 'plain', label: 'Plain text', hint: 'No formatting' },
  { kind: 'number', label: 'Number', hint: '1,234.56' },
  { kind: 'currency', label: 'Currency', hint: '$1,234.56' },
  { kind: 'percent', label: 'Percent', hint: '12.34%' },
  { kind: 'scientific', label: 'Scientific', hint: '1.23E+3' },
  { kind: 'date', label: 'Date' },
  { kind: 'time', label: 'Time' },
  { kind: 'datetime', label: 'Date and time' },
  { kind: 'text', label: 'Treat as text' },
];

interface ToolButtonProps {
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}

/**
 * `onMouseDown` is prevented on every control: the selection the command
 * applies to lives in the grid, and letting the button take focus would blur
 * the grid and lose it.
 */
const ToolButton: React.FC<ToolButtonProps> = ({ onClick, isActive, disabled, label, children }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    aria-pressed={isActive}
    disabled={disabled}
    onMouseDown={(event) => event.preventDefault()}
    onClick={onClick}
    className={cn(
      'p-2 rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none',
      isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
    )}
  >
    {children}
  </button>
);

const Divider: React.FC = () => <div className="w-[1px] h-6 bg-border mx-1" aria-hidden="true" />;

export interface SheetToolbarProps {
  format: CellFormat;
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  frozenRows: number;
  frozenColumns: number;
  onCommand: (command: FormatCommand) => void;
  onUndo: () => void;
  onRedo: () => void;
  onFreezeRows: (rows: number) => void;
  onFreezeColumns: (columns: number) => void;
}

/**
 * The formatting ribbon.
 *
 * Chrome, spacing, and the active treatment are lifted from the document
 * editor's toolbar rather than reinvented, so the two surfaces read as the same
 * product. It scrolls horizontally instead of wrapping, because a wrapped
 * toolbar changes the grid's height as the pane narrows.
 */
export const SheetToolbar: React.FC<SheetToolbarProps> = ({
  format,
  disabled,
  canUndo,
  canRedo,
  frozenRows,
  frozenColumns,
  onCommand,
  onUndo,
  onRedo,
  onFreezeRows,
  onFreezeColumns,
}) => {
  const numberKind = format.number?.kind ?? 'auto';
  const activeNumberFormat = NUMBER_FORMATS.find((entry) => entry.kind === numberKind);

  return (
    <div className="w-full overflow-x-auto scrollbar-thin">
      <div className="flex items-center gap-1 p-2 min-w-max">
        <ToolButton onClick={onUndo} disabled={!canUndo} label="Undo">
          <Undo2 size={16} />
        </ToolButton>
        <ToolButton onClick={onRedo} disabled={!canRedo} label="Redo">
          <Redo2 size={16} />
        </ToolButton>

        <Divider />

        <Select
          value={format.fontSize ? String(format.fontSize) : 'default'}
          onValueChange={(value) =>
            onCommand({
              kind: 'fontSize',
              value: value === 'default' ? undefined : Number(value),
            })
          }
          disabled={disabled}
        >
          <SelectTrigger className="h-8 w-[76px] text-xs" aria-label="Font size">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Default</SelectItem>
            {FONT_SIZES.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <ToolButton
          onClick={() => onCommand({ kind: 'toggle', field: 'bold' })}
          isActive={!!format.bold}
          disabled={disabled}
          label="Bold"
        >
          <Bold size={16} />
        </ToolButton>
        <ToolButton
          onClick={() => onCommand({ kind: 'toggle', field: 'italic' })}
          isActive={!!format.italic}
          disabled={disabled}
          label="Italic"
        >
          <Italic size={16} />
        </ToolButton>
        <ToolButton
          onClick={() => onCommand({ kind: 'toggle', field: 'underline' })}
          isActive={!!format.underline}
          disabled={disabled}
          label="Underline"
        >
          <Underline size={16} />
        </ToolButton>
        <ToolButton
          onClick={() => onCommand({ kind: 'toggle', field: 'strike' })}
          isActive={!!format.strike}
          disabled={disabled}
          label="Strikethrough"
        >
          <Strikethrough size={16} />
        </ToolButton>

        <SheetColorPicker
          value={format.color}
          onChange={(color) => onCommand({ kind: 'color', value: color })}
          icon={<Baseline size={16} />}
          label="Text colour"
          disabled={disabled}
        />
        <SheetColorPicker
          value={format.background}
          onChange={(color) => onCommand({ kind: 'background', value: color })}
          icon={<PaintBucket size={16} />}
          label="Fill colour"
          disabled={disabled}
        />

        <Divider />

        {(
          [
            ['left', AlignLeft, 'Align left'],
            ['center', AlignCenter, 'Align centre'],
            ['right', AlignRight, 'Align right'],
          ] as const
        ).map(([value, Icon, label]) => (
          <ToolButton
            key={value}
            // Pressing the active alignment clears it, returning the cell to the
            // type-driven default (numbers right, text left).
            onClick={() =>
              onCommand({ kind: 'align', value: format.align === value ? undefined : value })
            }
            isActive={format.align === value}
            disabled={disabled}
            label={label}
          >
            <Icon size={16} />
          </ToolButton>
        ))}
        <ToolButton
          onClick={() => onCommand({ kind: 'toggle', field: 'wrap' })}
          isActive={!!format.wrap}
          disabled={disabled}
          label="Wrap text"
        >
          <WrapText size={16} />
        </ToolButton>

        <Divider />

        <ToolButton
          onClick={() => onCommand({ kind: 'numberKind', value: 'currency' })}
          isActive={numberKind === 'currency'}
          disabled={disabled}
          label="Format as currency"
        >
          <DollarSign size={16} />
        </ToolButton>
        <ToolButton
          onClick={() => onCommand({ kind: 'numberKind', value: 'percent' })}
          isActive={numberKind === 'percent'}
          disabled={disabled}
          label="Format as percent"
        >
          <Percent size={16} />
        </ToolButton>
        <ToolButton
          onClick={() => onCommand({ kind: 'decimals', delta: -1 })}
          disabled={disabled}
          label="Decrease decimal places"
        >
          <span className="block w-4 text-[11px] font-medium tabular-nums leading-4">.0</span>
        </ToolButton>
        <ToolButton
          onClick={() => onCommand({ kind: 'decimals', delta: 1 })}
          disabled={disabled}
          label="Increase decimal places"
        >
          <span className="block w-4 text-[11px] font-medium tabular-nums leading-4">.00</span>
        </ToolButton>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Number format"
              title="Number format"
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              className="flex items-center gap-1 rounded-md p-2 text-xs transition-colors hover:bg-muted disabled:opacity-50"
            >
              {numberKind === 'date' || numberKind === 'time' || numberKind === 'datetime' ? (
                <Calendar size={16} />
              ) : (
                <Hash size={16} />
              )}
              <span className="max-w-[72px] truncate">{activeNumberFormat?.label ?? 'Automatic'}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Number format</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {NUMBER_FORMATS.map((entry) => (
              <DropdownMenuItem
                key={entry.kind}
                onSelect={() => onCommand({ kind: 'numberKind', value: entry.kind })}
                className={cn('flex justify-between gap-4', numberKind === entry.kind && 'bg-accent')}
              >
                <span>{entry.label}</span>
                {entry.hint && (
                  <span className="font-mono text-xs text-muted-foreground">{entry.hint}</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Divider />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Freeze panes"
              title="Freeze panes"
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              className={cn(
                'rounded-md p-2 transition-colors hover:bg-muted disabled:opacity-50',
                (frozenRows > 0 || frozenColumns > 0) && 'bg-primary text-primary-foreground',
              )}
            >
              <Snowflake size={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Freeze</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onFreezeRows(frozenRows > 0 ? 0 : 1)}>
              {frozenRows > 0 ? 'Unfreeze rows' : 'Freeze first row'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onFreezeColumns(frozenColumns > 0 ? 0 : 1)}>
              {frozenColumns > 0 ? 'Unfreeze columns' : 'Freeze first column'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <ToolButton
          onClick={() => onCommand({ kind: 'clear' })}
          disabled={disabled}
          label="Clear formatting"
        >
          <Eraser size={16} />
        </ToolButton>
      </div>
    </div>
  );
};
