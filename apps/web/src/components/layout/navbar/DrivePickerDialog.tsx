"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { Check, Folder, LayoutGrid, Plus, Star } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import CreateDriveDialog from "@/components/layout/left-sidebar/CreateDriveDialog";
import { useTouchDevice } from "@/hooks/useTouchDevice";
import type { Drive } from "@/hooks/useDrive";
import { cn } from "@/lib/utils";

import { useDrivePicker } from "./useDrivePicker";

interface DrivePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The drive picker: a command palette, not a dropdown.
 *
 * The 256px dropdown it replaces was too narrow for the size of a real drive
 * list and had to fold its search, its sections, and its two actions into one
 * scrolling column. Here the search input, the All drives / Create drive bar,
 * and the keyboard hints are fixed chrome; only the drive list scrolls.
 *
 * Filtering is done by `useDrivePicker`, not by cmdk — the groups have to
 * behave differently under a query (Recent disappears) and cmdk's built-in
 * fuzzy match would rank across groups we want kept apart.
 */
export default function DrivePickerDialog({ open, onOpenChange }: DrivePickerDialogProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [isCreateOpen, setCreateOpen] = useState(false);

  const {
    favoriteDrives,
    recentDrives,
    allDrives,
    currentDriveId,
    isSearching,
    selectDrive,
    isFavorite,
    toggleFavorite,
  } = useDrivePicker(query);

  const close = () => {
    onOpenChange(false);
    setQuery("");
  };

  const handleSelect = (drive: Drive) => {
    close();
    selectDrive(drive);
  };

  const renderItem = (drive: Drive, group: string) => (
    <DriveRow
      key={`${group}:${drive.id}`}
      drive={drive}
      group={group}
      isCurrent={drive.id === currentDriveId}
      isFavorite={isFavorite(drive.id)}
      onSelect={() => handleSelect(drive)}
      onToggleFavorite={() => toggleFavorite(drive.id)}
    />
  );

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={(next) => (next ? onOpenChange(true) : close())}
        title="Switch drive"
        description="Search your drives and open one"
        className="sm:max-w-xl"
        showCloseButton
      >
        <CommandInput placeholder="Search drives…" value={query} onValueChange={setQuery} />

        {/*
          Fixed chrome under the input, outside the list on purpose: cmdk's
          arrow keys walk CommandItems, and these two are destinations, not
          drives — they should not sit between ↓ and the first drive.
        */}
        <div className="grid grid-cols-2 border-b border-border bg-card">
          <button
            type="button"
            onClick={() => {
              close();
              router.push("/dashboard/drives");
            }}
            className="flex h-10 items-center justify-center gap-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:bg-accent focus-visible:text-foreground"
          >
            <LayoutGrid className="h-4 w-4" aria-hidden="true" />
            All drives
          </button>
          <button
            type="button"
            onClick={() => {
              close();
              setCreateOpen(true);
            }}
            className="flex h-10 items-center justify-center gap-2 border-l border-border text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:bg-accent focus-visible:text-foreground"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Create drive
          </button>
        </div>

        <CommandList className="max-h-[60vh]">
          <CommandEmpty>{isSearching ? "No drives match." : "No drives yet."}</CommandEmpty>

          {favoriteDrives.length > 0 && (
            <CommandGroup heading="Favorites">
              {favoriteDrives.map((drive) => renderItem(drive, "favorite"))}
            </CommandGroup>
          )}

          {recentDrives.length > 0 && !isSearching && (
            <CommandGroup heading="Recent">
              {recentDrives.map((drive) => renderItem(drive, "recent"))}
            </CommandGroup>
          )}

          {allDrives.length > 0 && (
            <CommandGroup heading={isSearching ? "Results" : `All drives · ${allDrives.length}`}>
              {allDrives.map((drive) => renderItem(drive, "all"))}
            </CommandGroup>
          )}
        </CommandList>

        <div
          aria-hidden="true"
          className="flex h-9 items-center gap-4 border-t border-border px-3.5 text-xs text-muted-foreground"
        >
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            move
          </span>
          <span>
            <Kbd>↵</Kbd>
            open drive
          </span>
          <span>
            <Kbd>esc</Kbd>
            close
          </span>
        </div>
      </CommandDialog>

      <CreateDriveDialog isOpen={isCreateOpen} setIsOpen={setCreateOpen} />
    </>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mr-1 inline-flex h-5 min-w-[18px] items-center justify-center rounded border border-border bg-card px-1 font-sans text-[11px] text-foreground">
      {children}
    </kbd>
  );
}

interface DriveRowProps {
  drive: Drive;
  group: string;
  isCurrent: boolean;
  isFavorite: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
}

function DriveRow({ drive, group, isCurrent, isFavorite, onSelect, onToggleFavorite }: DriveRowProps) {
  const isTouchDevice = useTouchDevice();

  const accessed =
    group === "recent" && drive.lastAccessedAt
      ? formatDistanceToNow(new Date(drive.lastAccessedAt), { addSuffix: true })
      : null;

  return (
    <CommandItem
      // Same drive can appear in Favorites and All; cmdk dedupes by value, so
      // the value carries the group.
      value={`${group}:${drive.id}`}
      onSelect={onSelect}
      className={cn("group/row cursor-pointer gap-2.5", isCurrent && "bg-primary-soft")}
      data-current={isCurrent ? "true" : undefined}
    >
      <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{drive.name}</span>
      {accessed && <span className="text-xs text-muted-foreground tabular-nums">{accessed}</span>}
      <button
        type="button"
        // cmdk selects the row on click; stop it here so a star tap never
        // switches drive.
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          onToggleFavorite();
        }}
        aria-label={isFavorite ? `Remove ${drive.name} from favorites` : `Add ${drive.name} to favorites`}
        aria-pressed={isFavorite}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-sm transition-opacity hover:bg-accent focus-visible:opacity-100",
          isTouchDevice || isFavorite ? "opacity-100" : "opacity-0 group-hover/row:opacity-100"
        )}
      >
        <Star
          className={cn(
            "h-3.5 w-3.5",
            isFavorite ? "fill-yellow-500 text-yellow-500" : "text-muted-foreground"
          )}
          aria-hidden="true"
        />
      </button>
      {isCurrent && <Check className="h-4 w-4 shrink-0 text-primary" aria-label="Current drive" />}
    </CommandItem>
  );
}
