'use client';

import { useState } from 'react';
import { ChevronsUpDown, Folder, Layers } from 'lucide-react';

import DriveSwitcherDialog from '@/components/layout/navbar/DriveSwitcherDialog';
import { useDriveStore } from '@/hooks/useDrive';
import { focusDriveId, type Focus, type FocusSection } from '@/lib/dashboard/focus';
import { cn } from '@/lib/utils';

const ALL_DRIVES_LABEL = 'All drives';

interface FocusTriggerProps {
  section: FocusSection;
  focus: Focus;
  /**
   * `text`: a subtitle-sized label with a chevron — what a page's own
   * "in this drive" line becomes once it can be pressed.
   * `compact`: icon only, for a phone header row that has no room for a word.
   */
  variant?: 'text' | 'compact';
  /** Compact only: match the row. `sm` is 32px (h-8), `md` is 36px (h-9). */
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Names the focus a section is showing — "All drives" or one drive — and
 * opens the one drive picker, which keeps the section when the focus
 * changes. Every section renders this in place of scope words in its
 * subtitle, so the page never needs a second drive menu of its own.
 *
 * The drive name comes from the store and is allowed to be missing: the
 * trigger must be pressable before drives have loaded.
 */
export function FocusTrigger({ section, focus, variant = 'text', size = 'md', className }: FocusTriggerProps) {
  const [open, setOpen] = useState(false);
  const driveId = focusDriveId(focus);
  const driveName = useDriveStore((state) =>
    driveId ? state.drives.find((drive) => drive.id === driveId)?.name : undefined
  );

  const isAll = focus.kind === 'all';
  const label = isAll ? ALL_DRIVES_LABEL : (driveName ?? 'This drive');
  const Icon = isAll ? Layers : Folder;
  const description = isAll
    ? `Viewing ${section} across all drives. Change focus.`
    : `Viewing ${section} in ${label}. Change focus.`;

  const trigger =
    variant === 'compact' ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={description}
        title={description}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          size === 'sm' ? 'h-8 w-8' : 'h-9 w-9',
          className
        )}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={description}
        title={label}
        // Visually a line of subtitle text; on a coarse pointer the padding
        // grows the hit area to 36px while a matching negative margin keeps
        // the line where it was. Height stays text height either way.
        className={cn(
          'inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1 -mx-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:-my-2 pointer-coarse:py-2',
          className
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </button>
    );

  return (
    <>
      {trigger}
      <DriveSwitcherDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
