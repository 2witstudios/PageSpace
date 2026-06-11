'use client';

import React from 'react';
import Link from 'next/link';
import { Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import {
  type CommandSuggestionItem,
  scopeBadgeLabel,
  shadowedTooltip,
  commandOptionAccessibleName,
  noMatchesCopy,
  COMMANDS_LOAD_ERROR,
  COMMANDS_SETTINGS_ROUTE,
} from '@/lib/commands/command-picker-core';
import type { CommandScope } from '@pagespace/lib/commands/command-core';

// Compact badge style mirroring the mention picker's group badge, with a
// distinct hue per scope (spec §1.5): personal = primary tint, drive = indigo
// (matching the mention group badge), built-in = muted/neutral.
const SCOPE_BADGE_CLASSES: Record<CommandScope, string> = {
  user: 'bg-primary/15 text-primary',
  drive: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
  builtin: 'bg-muted text-muted-foreground',
};

export interface CommandPickerPanelProps {
  items: CommandSuggestionItem[];
  loading: boolean;
  /** True when the suggest fetch failed — shows load-error copy instead of an empty state. */
  loadFailed: boolean;
  /** The text typed after `/` in the message input (there is no inner search field). */
  query: string;
  selectedIndex: number;
  onSelect: (item: CommandSuggestionItem) => void;
  onSelectionChange: (index: number) => void;
  /** id for the listbox element (`aria-controls` on the textarea points here). */
  listboxId: string;
  /** id generator for option elements (`aria-activedescendant` targets). */
  optionId: (index: number) => string;
  /** Whether the user has any resolvable commands at all (empty-state copy switch). */
  hasAnyCommands: boolean;
  /** Called when the empty state's settings link is followed (closes the picker). */
  onNavigateToSettings?: () => void;
  className?: string;
}

/**
 * Command picker panel — mirrors `MentionPickerPanel`'s interaction grammar
 * and row density (spec §1.4) with the documented deltas: no tabs, no inner
 * search input (focus stays in the message textarea; keyboard events are
 * handled there via `useCommandSuggestion`).
 */
export function CommandPickerPanel({
  items,
  loading,
  loadFailed,
  query,
  selectedIndex,
  onSelect,
  onSelectionChange,
  listboxId,
  optionId,
  hasAnyCommands,
  onNavigateToSettings,
  className,
}: CommandPickerPanelProps) {
  return (
    <div className={cn('w-full', className)}>
      <div className="max-h-64 overflow-y-auto overscroll-contain">
        {loading ? (
          <div className="p-3 text-sm text-muted-foreground flex items-center gap-2">
            <span className="animate-spin inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full" />
            Loading…
          </div>
        ) : loadFailed ? (
          <div className="p-3 text-sm text-muted-foreground">{COMMANDS_LOAD_ERROR}</div>
        ) : items.length === 0 ? (
          !hasAnyCommands ? (
            // Exact copy: NO_COMMANDS_EMPTY_STATE (spec §1.4), with the
            // settings path rendered as a navigating link.
            <div className="p-3 text-sm text-muted-foreground">
              No commands yet. Create one in{' '}
              <Link
                href={COMMANDS_SETTINGS_ROUTE}
                className="text-primary underline underline-offset-2"
                onClick={() => onNavigateToSettings?.()}
              >
                Settings → AI Settings → Commands
              </Link>
              .
            </div>
          ) : (
            <div className="p-3 text-sm text-muted-foreground">{noMatchesCopy(query)}</div>
          )
        ) : (
          <ul role="listbox" id={listboxId} aria-label="Commands">
            {items.map((item, index) => {
              const isShadowed = item.shadowedBy !== undefined;
              return (
                <li
                  key={`${item.id}-${index}`}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === selectedIndex}
                  aria-label={commandOptionAccessibleName(item)}
                  onClick={() => onSelect(item)}
                  onMouseEnter={() => onSelectionChange(index)}
                  className={cn(
                    'px-3 py-2 cursor-pointer flex items-center gap-2',
                    'hover:bg-muted/50 transition-colors',
                    index === selectedIndex && 'bg-muted/50',
                    isShadowed && 'opacity-60'
                  )}
                >
                  <span className="text-sm font-medium text-foreground shrink-0">
                    /{item.trigger}
                  </span>
                  <span
                    data-testid="command-scope-badge"
                    className={cn(
                      'text-xs rounded px-1 py-0.5 shrink-0',
                      SCOPE_BADGE_CLASSES[item.scope]
                    )}
                  >
                    {scopeBadgeLabel(item.scope)}
                  </span>
                  {isShadowed && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span data-testid="command-shadow-indicator" className="shrink-0 text-muted-foreground">
                          <Layers className="w-3 h-3" aria-hidden="true" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{shadowedTooltip(item)}</TooltipContent>
                    </Tooltip>
                  )}
                  {item.description && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs text-muted-foreground truncate">
                          {item.description}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-72">{item.description}</TooltipContent>
                    </Tooltip>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default CommandPickerPanel;
