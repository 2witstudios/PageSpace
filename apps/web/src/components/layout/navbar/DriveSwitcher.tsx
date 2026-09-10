"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ChevronsUpDown, Folder, Layers } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDriveStore } from "@/hooks/useDrive";

import DriveSwitcherDialog from "./DriveSwitcherDialog";

/**
 * The sidebar's drive trigger. It keeps the URL and the drive store in step
 * and opens the drive picker; the picker itself is shared with the header's
 * drive crumb, so there is one list, one "recent", and one way to switch.
 */
export default function DriveSwitcher() {
  const params = useParams();
  const [isOpen, setIsOpen] = useState(false);

  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const setCurrentDrive = useDriveStore((state) => state.setCurrentDrive);

  const { driveId } = params;
  const urlDriveId = Array.isArray(driveId) ? driveId[0] : driveId;

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  useEffect(() => {
    if (urlDriveId && drives.length > 0) {
      const currentDrive = drives.find((d) => d.id === urlDriveId);
      if (currentDrive) {
        setCurrentDrive(currentDrive.id);
      }
    } else if (!urlDriveId) {
      setCurrentDrive(null);
    }
  }, [urlDriveId, drives, setCurrentDrive]);

  // Looked up by the route's drive, like FocusTrigger, so a drive the list
  // has not caught up with never shows the previous drive's name.
  const currentDrive = useMemo(
    () => (urlDriveId ? drives.find((d) => d.id === urlDriveId) : undefined),
    [drives, urlDriveId]
  );

  if (isLoading) {
    return <Skeleton className="h-9 w-40" />;
  }

  return (
    <>
      <Button
        variant="ghost"
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        className="flex items-center gap-2 px-2 h-9 min-w-0 max-w-full"
      >
        {/*
          No drive open IS the All drives focus, so this names it as such:
          "Select Drive" implied nothing was chosen, when every section is
          already showing all of them.
        */}
        {urlDriveId ? (
          <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        {/* Keyed on the route, not the store: a drive the store has not
            loaded is still the focus, so it must not read as All drives. */}
        <span className="truncate font-medium">
          {urlDriveId ? (currentDrive?.name ?? "This drive") : "All drives"}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </Button>

      <DriveSwitcherDialog open={isOpen} onOpenChange={setIsOpen} />
    </>
  );
}
