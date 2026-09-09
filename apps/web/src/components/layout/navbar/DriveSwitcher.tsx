"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ChevronsUpDown, Folder } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDriveStore } from "@/hooks/useDrive";
import { useFavoritesSync } from "@/hooks/useFavorites";

import DrivePickerDialog from "./DrivePickerDialog";

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
  const currentDriveId = useDriveStore((state) => state.currentDriveId);
  const setCurrentDrive = useDriveStore((state) => state.setCurrentDrive);

  useFavoritesSync();

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

  const currentDrive = useMemo(
    () => drives.find((d) => d.id === currentDriveId),
    [drives, currentDriveId]
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
        <Folder className="h-4 w-4 shrink-0" />
        <span className="truncate font-medium">
          {currentDrive ? currentDrive.name : "Select Drive"}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </Button>

      <DrivePickerDialog open={isOpen} onOpenChange={setIsOpen} />
    </>
  );
}
