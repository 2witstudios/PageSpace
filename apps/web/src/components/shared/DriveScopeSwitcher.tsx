'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Check, ChevronsUpDown, Folder, Layers } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDriveStore } from '@/hooks/useDrive';
import { cn } from '@/lib/utils';

/**
 * The four surfaces that exist both as a drive-scoped view
 * (`/dashboard/[driveId]/<section>`) and as a global, cross-drive view.
 */
export type DriveScopedSection = 'channels' | 'files' | 'tasks' | 'calendar';

/**
 * The global counterpart of each section. Files has no cross-drive listing
 * of its own, so the drives browser stands in for it — the same mapping the
 * left sidebar's primary navigation uses.
 */
const GLOBAL_HREF: Record<DriveScopedSection, string> = {
  channels: '/dashboard/channels',
  files: '/dashboard/drives',
  tasks: '/dashboard/tasks',
  calendar: '/dashboard/calendar',
};

const ALL_DRIVES_LABEL = 'All drives';

export function globalSectionHref(section: DriveScopedSection): string {
  return GLOBAL_HREF[section];
}

export function driveSectionHref(section: DriveScopedSection, driveId: string): string {
  return `/dashboard/${driveId}/${section}`;
}

interface DriveScopeSwitcherProps {
  section: DriveScopedSection;
  /** The drive the view is scoped to; omit on the global view. */
  driveId?: string;
  /** Icon-only trigger for tight mobile headers. */
  compact?: boolean;
  className?: string;
}

/**
 * Lets a drive-scoped view jump to its global counterpart and back.
 *
 * Every section (channels, files, tasks, calendar) is reachable in two
 * shapes: "this drive" and "everything I can see". The sidebar swaps its
 * links depending on which shape you are in, which means the *other* shape
 * has no affordance at all from inside the view. This one control sits in
 * each view's header and offers both: the global view, and every drive's
 * version of the same section.
 *
 * Drives come from the store and are allowed to be missing: the global
 * entry is always rendered, so the way out never waits on a fetch.
 */
export function DriveScopeSwitcher({ section, driveId, compact = false, className }: DriveScopeSwitcherProps) {
  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);

  useEffect(() => {
    // Cached for five minutes inside the store; this is a no-op in the
    // common case where the sidebar already loaded them.
    fetchDrives();
  }, [fetchDrives]);

  const activeDrives = drives.filter((drive) => !drive.isTrashed);
  const currentDrive = driveId ? drives.find((drive) => drive.id === driveId) : undefined;
  const isGlobal = !driveId;

  const currentLabel = isGlobal ? ALL_DRIVES_LABEL : (currentDrive?.name ?? 'This drive');
  const CurrentIcon = isGlobal ? Layers : Folder;
  const triggerTitle = isGlobal
    ? `Viewing ${section} across all drives. Switch to a drive.`
    : `Viewing ${section} in ${currentLabel}. Switch drive or view all drives.`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={compact ? 'icon' : 'sm'}
          className={cn(compact ? 'h-9 w-9 shrink-0' : 'h-9 max-w-[220px] gap-1.5', className)}
          aria-label={compact ? triggerTitle : undefined}
          title={triggerTitle}
        >
          <CurrentIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {!compact && (
            <>
              <span className="truncate">{currentLabel}</span>
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Show {section} for
        </DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link href={GLOBAL_HREF[section]} aria-current={isGlobal ? 'page' : undefined}>
            <Layers className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1 truncate">{ALL_DRIVES_LABEL}</span>
            {isGlobal && <Check className="h-4 w-4" aria-hidden="true" />}
          </Link>
        </DropdownMenuItem>
        {activeDrives.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <div className="max-h-72 overflow-y-auto">
              {activeDrives.map((drive) => {
                const isCurrent = drive.id === driveId;
                return (
                  <DropdownMenuItem key={drive.id} asChild>
                    <Link href={driveSectionHref(section, drive.id)} aria-current={isCurrent ? 'page' : undefined}>
                      <Folder className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      <span className="flex-1 truncate">{drive.name}</span>
                      {isCurrent && <Check className="h-4 w-4" aria-hidden="true" />}
                    </Link>
                  </DropdownMenuItem>
                );
              })}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
