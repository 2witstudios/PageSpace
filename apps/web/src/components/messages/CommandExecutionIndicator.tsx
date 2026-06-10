'use client';

import { SlashSquare } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { buildExecutionIndicatorViewModel } from '@/lib/commands/execution-indicator-model';

/**
 * Command execution indicator (UX spec §7): the "Using /foo" pill attached
 * to an AI response, or the "Skipped /foo — {reason}" notice. Announced
 * once per response via a polite live region (§9). Renders nothing for
 * malformed payloads — the payload travels as an untyped data part.
 */
export function CommandExecutionIndicator({ data }: { data: unknown }) {
  const vm = buildExecutionIndicatorViewModel(data);
  if (!vm) return null;

  const pill = (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 mb-1 text-xs w-fit',
        vm.skipped
          ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
          : 'border-border bg-muted/60 text-muted-foreground'
      )}
    >
      <SlashSquare size={12} aria-hidden="true" className="shrink-0" />
      {vm.text}
    </div>
  );

  if (!vm.tooltip) return pill;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{pill}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        {vm.tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
