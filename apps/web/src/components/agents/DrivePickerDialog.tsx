'use client';

import { Bot, Folder } from 'lucide-react';

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
 * When `onPickGlobalAssistant` is provided (the session flow — a drive-less
 * assistant session is a valid target there, unlike "New agent", which needs
 * a drive to navigate into), a "Global Assistant" entry is listed above the
 * drives.
 */
export default function DrivePickerDialog({
  open,
  onOpenChange,
  onPick,
  onPickGlobalAssistant,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (driveId: string, driveName: string) => void;
  onPickGlobalAssistant?: () => void;
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
        <CommandEmpty>No drives found.</CommandEmpty>
        {onPickGlobalAssistant && (
          <CommandGroup>
            <CommandItem value="assistant-Global Assistant" onSelect={onPickGlobalAssistant}>
              <Bot className="size-3.5" aria-hidden="true" />
              <span className="truncate">Global Assistant</span>
            </CommandItem>
          </CommandGroup>
        )}
        <CommandGroup>
          {drives.map((drive) => (
            <CommandItem
              key={drive.id}
              value={`${drive.id}-${drive.name}`}
              onSelect={() => onPick(drive.id, drive.name)}
            >
              <Folder className="size-3.5" aria-hidden="true" />
              <span className="truncate">{drive.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
