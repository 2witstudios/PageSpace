import { cn } from '../../cn';

/** The picker's trigger in Imago's head: spark tile, the agent's name, a chevron (C-Files-Doc). */
export const pickerTriggerClass =
  'group -ml-1 flex h-8 cursor-pointer items-center gap-2 rounded-md px-1 text-sm font-semibold text-ink summary-plain hover:bg-fill';

/** The 22px spark tile: spine blue for Imago, the agent hue for a drive agent. */
export const agentTileClass = (imago: boolean, size: 'head' | 'row'): string =>
  cn(
    'flex flex-none items-center justify-center',
    size === 'head' ? 'size-agent-tile rounded-md' : 'size-agent-row-tile rounded-lg',
    imago ? 'bg-spine text-spine-on' : 'bg-agent-soft text-type-agent',
  );

/** The popover under the head (C-Chat-AgentPicker): a non-modal dialog. */
export const pickerPopoverClass =
  'absolute top-full left-0 z-popover mt-1 flex w-agent-picker flex-col rounded-xl border border-hairline bg-surface-raised shadow-3';

export const pickerHeadClass = 'flex items-center justify-between px-3 pt-3 pb-1 text-xs font-medium text-ink-muted';

export const pickerGroupLabelClass = 'px-3 pt-2 pb-1 text-2xs font-medium tracking-wide text-ink-muted uppercase';

/** One 48px agent row. */
export const pickerRowClass = (checked: boolean, disabled: boolean): string =>
  cn(
    'flex h-12 w-full items-center gap-3 border-0 bg-transparent px-3 text-left',
    disabled ? 'cursor-default opacity-50' : 'cursor-pointer hover:bg-fill',
    checked && 'bg-accent-soft',
  );

export const pickerFooterClass =
  'mt-1 flex items-center gap-3 border-t border-hairline px-3 py-2 text-xs text-ink-muted';
