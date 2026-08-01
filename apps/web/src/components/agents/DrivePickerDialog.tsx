'use client';

import { Folder } from 'lucide-react';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useDriveStore } from '@/hooks/useDrive';

/**
 * Picks a drive to create something in — the step "New session" and "New
 * agent" need on the global Agents page, which has no drive of its own.
 * Trashed drives are excluded, same as `AgentsSidebar`'s own drive roster.
 */
export default function DrivePickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (driveId: string, driveName: string) => void;
}) {
  const drives = useDriveStore((state) => state.drives).filter((drive) => !drive.isTrashed);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Choose a drive"
      description="Pick which drive to create this in"
      showCloseButton={false}
      className="max-w-[420px]"
    >
      <CommandInput placeholder="Search drives…" autoFocus />
      <CommandList>
        <CommandEmpty>No drives yet.</CommandEmpty>
        <CommandGroup>
          {drives.map((drive) => (
            <CommandItem key={drive.id} value={drive.name} onSelect={() => onPick(drive.id, drive.name)}>
              <Folder className="size-3.5" aria-hidden="true" />
              <span className="truncate">{drive.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
