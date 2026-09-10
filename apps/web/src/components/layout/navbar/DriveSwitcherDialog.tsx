"use client";

import { useState } from "react";
import type { KeyboardEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import { Check, Folder, Layers, Plus, Star } from "lucide-react";

import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import CreateDriveDialog from "@/components/layout/left-sidebar/CreateDriveDialog";
import { useTouchDevice } from "@/hooks/useTouchDevice";
import { useFavoritesSync } from "@/hooks/useFavorites";
import { focusDriveId, useFocus } from "@/lib/dashboard/focus";
import type { Drive } from "@/hooks/useDrive";
import { cn } from "@/lib/utils";

import { useDrivePicker } from "./useDrivePicker";

interface DriveSwitcherDialogProps {
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
export default function DriveSwitcherDialog({ open, onOpenChange }: DriveSwitcherDialogProps) {
  const [isCreateOpen, setCreateOpen] = useState(false);

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Switch drive"
        description="Search your drives and open one"
        // Phone: top-anchored 12px below the safe area instead of centred, so
        // the keyboard never covers the input and the notch never covers the
        // dialog (the header pads the same inset; in the iOS app it is real);
        // the dialog becomes a column whose list takes whatever height is left
        // above the bottom inset. sm+: the usual centred 576px.
        className="max-sm:top-[calc(var(--safe-area-top)+0.75rem)] max-sm:flex max-sm:max-h-[calc(100dvh-var(--safe-area-top)-var(--safe-area-bottom)-1.5rem)] max-sm:max-w-[calc(100%-1.5rem)] max-sm:translate-y-0 max-sm:flex-col sm:max-w-xl"
        showCloseButton
        // useDrivePicker owns filtering (Recent must vanish under a query, and
        // groups must not be re-ranked against each other). Item values are
        // `group:id`, so cmdk's own filter would hide rows matched by name.
        shouldFilter={false}
      >
        {/*
          The body — its query, its store subscriptions, its favourites sync —
          mounts only while the dialog is open. Every section's focus line
          renders one of these, and a closed one must cost a single state.
        */}
        <DrivePickerBody
          onClose={() => onOpenChange(false)}
          onCreate={() => {
            onOpenChange(false);
            setCreateOpen(true);
          }}
        />
      </CommandDialog>

      <CreateDriveDialog isOpen={isCreateOpen} setIsOpen={setCreateOpen} />
    </>
  );
}

interface DrivePickerBodyProps {
  onClose: () => void;
  onCreate: () => void;
}

function DrivePickerBody({ onClose, onCreate }: DrivePickerBodyProps) {
  const [query, setQuery] = useState("");
  // This dialog opens from every section's subtitle, including on a phone
  // where nothing else that syncs favourites is mounted.
  useFavoritesSync();

  const {
    favoriteDrives,
    recentDrives,
    allDrives,
    isSearching,
    selectDrive,
    selectAllDrives,
    isFavorite,
    toggleFavorite,
  } = useDrivePicker(query);

  // The query needs no reset: this body unmounts with the dialog.
  const close = () => onClose();

  const handleSelect = (drive: Drive) => {
    close();
    selectDrive(drive);
  };

  // All drives is first and highlighted with no query, so a stray Enter on
  // the focus you are already in must be a no-op, not a trip to its home.
  const handleSelectAll = () => {
    close();
    if (isAllDrivesCurrent) return;
    selectAllDrives();
  };

  // Current comes from the route, not the persisted store: the store is only
  // synced to the URL while the sidebar is mounted, which on a phone (a closed
  // sheet) it is not, while this dialog opens from every section's subtitle.
  const focus = useFocus();
  const currentDriveId = focusDriveId(focus);
  const isAllDrivesCurrent = focus.kind === "all";

  // cmdk highlights its first row after every keystroke and Enter picks it.
  // With no query All drives is first: the way out, one Enter away. Under a
  // query it moves BELOW the results, so Enter picks the typed drive and the
  // row is still reachable for someone who typed "all".
  const allDrivesRow = (
    <CommandGroup>
      <CommandItem
        value="focus:all"
        onSelect={handleSelectAll}
        aria-label={isAllDrivesCurrent ? "All drives, current" : "All drives"}
        aria-current={isAllDrivesCurrent ? "true" : undefined}
        className={cn("cursor-pointer gap-2.5", isAllDrivesCurrent && "bg-primary-soft")}
        data-current={isAllDrivesCurrent ? "true" : undefined}
        data-focus="all"
      >
        <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">All drives</span>
        {isAllDrivesCurrent && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
      </CommandItem>
    </CommandGroup>
  );

  // Shift+Enter favourites the highlighted row. cmdk keeps focus on the input
  // and walks rows via aria-activedescendant, so a button INSIDE a row is
  // unreachable from the keyboard and invisible to a screen reader; the star
  // is therefore a pointer affordance only, and this is the accessible path.
  // Capture phase, so cmdk's own Enter (select) never sees it.
  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || !event.shiftKey) return;
    // Whatever is highlighted, Shift+Enter never selects: on a row that is
    // not a drive (All drives) it is a no-op rather than a navigation.
    event.preventDefault();
    event.stopPropagation();
    const selected = event.currentTarget.querySelector<HTMLElement>(
      '[cmdk-item][data-selected="true"][data-drive-id]'
    );
    if (!selected?.dataset.driveId) return;
    void toggleFavorite(selected.dataset.driveId);
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
      <div className="flex min-h-0 flex-1 flex-col" onKeyDownCapture={handleKeyDownCapture}>
      <CommandInput placeholder="Search drives…" value={query} onValueChange={setQuery} />

      {/*
        Fixed chrome under the input, outside the list on purpose: cmdk's
        arrow keys walk CommandItems, and Create drive is an action, not a
        destination — it should not sit between ↓ and the first row.
      */}
      <div className="flex border-b border-border bg-card">
        <button
          type="button"
          onClick={onCreate}
          className="flex h-10 flex-1 items-center justify-center gap-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:bg-accent focus-visible:text-foreground"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Create drive
        </button>
      </div>

      <CommandList className="max-h-[60vh] max-sm:min-h-0 max-sm:flex-1 max-sm:max-h-none">
        {/*
          All drives is a focus like any drive, so it is a row, first, and
          it survives a query: the way out of a drive must never depend on
          what was typed. Picking it keeps the section you are in.
        */}
        {!isSearching && allDrivesRow}

        {/* cmdk's own empty state never fires now that All drives is always a row. */}
        {allDrives.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground" role="status">
            {isSearching ? "No drives match." : "No drives yet."}
          </div>
        )}

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

        {/* Not when nothing matched: alone it would be highlighted, and Enter on a typo must not leave the drive. */}

        {isSearching && allDrives.length > 0 && allDrivesRow}
      </CommandList>

      {/* Keyboard hints for a keyboard: gone on touch, where there is none to hint at. */}
      <div
        aria-hidden="true"
        className="flex h-9 items-center gap-4 border-t border-border px-3.5 text-xs text-muted-foreground pointer-coarse:hidden"
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
          <Kbd>⇧↵</Kbd>
          favorite
        </span>
        <span>
          <Kbd>esc</Kbd>
          close
        </span>
      </div>
      </div>
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
      // the value carries the group. Filtering is ours (shouldFilter=false),
      // so an opaque value is fine.
      value={`${group}:${drive.id}`}
      onSelect={onSelect}
      // The option's name carries the state a nested control cannot: cmdk rows
      // are reached by aria-activedescendant, so nothing inside them is a
      // separate control to assistive tech.
      aria-label={[drive.name, isCurrent ? "current drive" : null, isFavorite ? "favorite" : null]
        .filter(Boolean)
        .join(", ")}
      className={cn("group/row cursor-pointer gap-2.5", isCurrent && "bg-primary-soft")}
      data-current={isCurrent ? "true" : undefined}
      data-drive-id={drive.id}
    >
      <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{drive.name}</span>
      {accessed && <span className="text-xs text-muted-foreground tabular-nums">{accessed}</span>}
      {/*
        Pointer affordance only (aria-hidden): the keyboard path is Shift+Enter
        on the highlighted row, listed in the hint footer. cmdk selects the
        row on click, so stop the click here or a star tap switches drive.
      */}
      <span
        role="presentation"
        aria-hidden="true"
        data-testid="favorite-toggle"
        title={isFavorite ? "Remove from favorites" : "Add to favorites"}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          onToggleFavorite();
        }}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-sm transition-opacity hover:bg-accent",
          isTouchDevice || isFavorite ? "opacity-100" : "opacity-0 group-hover/row:opacity-100"
        )}
      >
        <Star
          className={cn(
            "h-3.5 w-3.5",
            isFavorite ? "fill-yellow-500 text-yellow-500" : "text-muted-foreground"
          )}
        />
      </span>
      {isCurrent && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
    </CommandItem>
  );
}
