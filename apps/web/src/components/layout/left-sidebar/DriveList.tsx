'use client';

import { useEffect, useMemo } from "react";
import { useParams, usePathname } from "next/navigation";
import Link from 'next/link';
import { useDriveStore } from '@/hooks/useDrive';
import { useGlobalDriveSocket } from '@/hooks/useGlobalDriveSocket';
import { Skeleton } from "@/components/ui/skeleton";
import { Drive } from "@/hooks/useDrive";
import { Folder, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

const DriveListItem = ({ drive, isActive }: { drive: Drive; isActive: boolean }) => (
  <Link href={`/dashboard/${drive.id}`} key={drive.id}>
    <div
      className={cn(
        "flex items-center gap-2 p-2 rounded-md text-sm font-medium",
        isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      )}
    >
      <Folder className="h-4 w-4" />
      <span className="truncate">{drive.name}</span>
    </div>
  </Link>
);

export default function DriveList() {
  const params = useParams();
  const pathname = usePathname();
  const {
    drives,
    fetchDrives,
    isLoading,
    setCurrentDrive
  } = useDriveStore();
  
  // Enable real-time drive updates
  useGlobalDriveSocket();

  const { driveId } = params;
  const urlDriveId = Array.isArray(driveId) ? driveId[0] : driveId;
  const isTrashView = pathname.includes('/trash');

  useEffect(() => {
    if (urlDriveId) {
        const currentDrive = drives.find(d => d.id === urlDriveId);
        if (currentDrive) {
            setCurrentDrive(currentDrive.id);
        }
    }
  }, [urlDriveId, drives, setCurrentDrive]);

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

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
    return (
      <div className="space-y-4 p-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {ownedDrives.length > 0 && (
        <div>
          <h3 className="px-2 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">My Drive</h3>
          <div className="space-y-1">
            {ownedDrives.map((drive) => (
              <DriveListItem key={drive.id} drive={drive} isActive={!isTrashView && drive.id === urlDriveId} />
            ))}
          </div>
        </div>
      )}
      {sharedDrives.length > 0 && (
        <div>
          <h3 className="px-2 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Shared Drives</h3>
          <div className="space-y-1">
            {sharedDrives.map((drive) => (
              <DriveListItem key={drive.id} drive={drive} isActive={!isTrashView && drive.id === urlDriveId} />
            ))}
          </div>
        </div>
      )}
       {drives.length === 0 && (
         <p className="p-2 text-sm text-gray-500">No drives found.</p>
      )}
      {urlDriveId && (
        <div>
          <Link href={`/dashboard/${urlDriveId}/trash`}>
            <div
              className={cn(
                "flex items-center gap-2 p-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                isTrashView && "bg-accent text-accent-foreground"
              )}
            >
              <Trash2 className="h-4 w-4" />
              <span className="truncate">Trash</span>
            </div>
          </Link>
        </div>
      )}
    </div>
  );
}