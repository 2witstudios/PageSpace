"use client";

import React from 'react';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface SheetTabBarProps {
  /** The tab being edited — always the first in the document. */
  activeName: string;
  /** Names of the tabs carried through but not rendered. */
  otherNames: string[];
}

/**
 * The tab strip along the bottom of the sheet.
 *
 * The editor renders the first tab only. Before this the others were invisible
 * — the document round-tripped them correctly (that landed with the engine
 * work) but nothing told the user they existed, so a three-tab workbook looked
 * like a one-tab workbook that had lost two. They are shown here, disabled and
 * labelled, until the editor can switch between them.
 */
export const SheetTabBar: React.FC<SheetTabBarProps> = ({ activeName, otherNames }) => (
  <div
    role="tablist"
    aria-label="Sheet tabs"
    className="flex items-center gap-1 overflow-x-auto border-t border-[var(--separator)] px-3 py-1 scrollbar-thin"
  >
    <button
      type="button"
      role="tab"
      aria-selected
      className="shrink-0 rounded-md bg-muted px-3 py-1 text-xs font-medium text-foreground"
    >
      {activeName}
    </button>

    {otherNames.map((name) => (
      <Tooltip key={name}>
        <TooltipTrigger asChild>
          {/*
            `aria-disabled` rather than `disabled`: a disabled button dispatches
            no pointer events and takes no focus, so the tooltip explaining why
            the tab cannot be opened was unreachable by both mouse and keyboard
            — and that explanation is the only reason the tooltip exists.
          */}
          <button
            type="button"
            role="tab"
            aria-selected={false}
            aria-disabled
            onClick={(event) => event.preventDefault()}
            className={cn(
              'flex shrink-0 cursor-default items-center gap-1 rounded-md px-3 py-1 text-xs',
              'text-muted-foreground opacity-70',
              'focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
            )}
          >
            <Lock size={12} />
            {name}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          This tab is kept intact but cannot be opened yet — only the first tab is editable.
        </TooltipContent>
      </Tooltip>
    ))}
  </div>
);
