"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDriveStore } from "@/hooks/useDrive";
import { focusPresentation } from "@/components/shared/FocusTrigger";
import { focusDriveId, useFocus } from "@/lib/dashboard/focus";

import DriveSwitcherDialog from "./DriveSwitcherDialog";

/**
 * The sidebar's drive trigger. It keeps the URL and the drive store in step
 * and opens the drive picker; the picker itself is shared with the header's
 * drive crumb, so there is one list, one "recent", and one way to switch.
 */
export default function DriveSwitcher() {
  const [isOpen, setIsOpen] = useState(false);
  const focus = useFocus();

  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const setCurrentDrive = useDriveStore((state) => state.setCurrentDrive);

  const urlDriveId = focusDriveId(focus);

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

  // Looked up by the route's drive, so a drive the list has not caught up
  // with never shows the previous drive's name.
  const currentDrive = useMemo(
    () => (urlDriveId ? drives.find((d) => d.id === urlDriveId) : undefined),
    [drives, urlDriveId]
  );
  const { label, Icon } = focusPresentation(focus, currentDrive?.name);

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
        {/* No drive open IS the All drives focus, and it is named as such. */}
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate font-medium">{label}</span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </Button>

      <DriveSwitcherDialog open={isOpen} onOpenChange={setIsOpen} />
    </>
  );
}
