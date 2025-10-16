"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronsUpDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useDriveStore } from "@/hooks/useDrive";
import { Skeleton } from "@/components/ui/skeleton";
import CreateDriveDialog from "@/components/layout/left-sidebar/CreateDriveDialog";
import { Drive } from "@pagespace/lib/client-safe";

export default function DriveSwitcher() {
  const router = useRouter();
  const params = useParams();

  // Use selective Zustand subscriptions to prevent unnecessary re-renders
  const drives = useDriveStore(state => state.drives);
  const fetchDrives = useDriveStore(state => state.fetchDrives);
  const isLoading = useDriveStore(state => state.isLoading);
  const currentDriveId = useDriveStore(state => state.currentDriveId);
  const setCurrentDrive = useDriveStore(state => state.setCurrentDrive);

  const [isCreateDriveOpen, setCreateDriveOpen] = useState(false);

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

  const handleSelectDrive = (drive: Drive) => {
    setCurrentDrive(drive.id);
    router.push(`/dashboard/${drive.id}`);
  };

  const { ownedDrives, sharedDrives } = useMemo(() => {
    const owned: Drive[] = [];
    const shared: Drive[] = [];
    drives.forEach((d) => {
      if (d.isOwned) {
        owned.push(d);
      } else {
        shared.push(d);
      }
    });
    return { ownedDrives: owned, sharedDrives: shared };
  }, [drives]);

  if (isLoading) {
    return <Skeleton className="h-9 w-full" />;
  }

  return (
    <>
      <DropdownMenu>
        <div className="flex items-center gap-2 p-2">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground">
              <ChevronsUpDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <Link href={currentDrive ? `/dashboard/${currentDrive.id}` : '/dashboard'} className="font-semibold truncate hover:underline flex-1 text-foreground">
            {currentDrive ? currentDrive.name : "Select a drive"}
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 text-muted-foreground h-8 w-8"
            onClick={() => setCreateDriveOpen(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <DropdownMenuContent className="w-56">
          {ownedDrives.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>My Drive</DropdownMenuLabel>
              {ownedDrives.map((drive) => (
                <DropdownMenuItem
                  key={drive.id}
                  onSelect={() => handleSelectDrive(drive)}
                >
                  {drive.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          )}
          {sharedDrives.length > 0 && (
            <DropdownMenuGroup>
              <DropdownMenuLabel>Shared Drives</DropdownMenuLabel>
              {sharedDrives.map((drive) => (
                <DropdownMenuItem
                  key={drive.id}
                  onSelect={() => handleSelectDrive(drive)}
                >
                  <span className="flex-1">{drive.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          )}
          {drives.length === 0 && (
             <DropdownMenuItem disabled>No drives found</DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreateDriveOpen(true)}>
            Create Drive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateDriveDialog
        isOpen={isCreateDriveOpen}
        setIsOpen={setCreateDriveOpen}
      />
    </>
  );
}