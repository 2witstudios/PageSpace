"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  Folder,
  Grip,
  List,
  Plus,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDriveStore, type Drive } from "@/hooks/useDrive";
import { useFavorites } from "@/hooks/useFavorites";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
import CreateDriveDialog from "@/components/layout/left-sidebar/CreateDriveDialog";
import { DriveContextMenu } from "./DriveContextMenu";
import { Skeleton } from "@/components/ui/skeleton";

type ViewMode = "grid" | "list";
type SortKey = "name" | "role" | "lastAccessedAt" | "createdAt";
type SortDirection = "asc" | "desc";

export function DrivesSkeleton() {
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-full">
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <Skeleton className="h-8 w-32" />
            <div className="flex gap-2">
              <Skeleton className="h-9 w-9" />
              <Skeleton className="h-9 w-9" />
              <Skeleton className="h-9 w-28" />
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatRole(role: string) {
  return role.charAt(0) + role.slice(1).toLowerCase();
}

export default function DrivesBrowser() {
  const router = useRouter();
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [isCreateDriveOpen, setCreateDriveOpen] = useState(false);

  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  const isLoading = useDriveStore((state) => state.isLoading);

  const {
    isFavorite,
    fetchFavorites,
    isSynced,
    driveIds: favoriteDriveIds,
  } = useFavorites();

  useEffect(() => {
    fetchDrives(false, true);
  }, [fetchDrives]);

  useEffect(() => {
    if (!isSynced) {
      fetchFavorites();
    }
  }, [isSynced, fetchFavorites]);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDirection("asc");
    }
  };

  const { favoriteDrives, myDrives, sharedDrives } = useMemo(() => {
    const sortFn = (list: Drive[]) =>
      [...list].sort((a, b) => {
        let aVal: string | number = "";
        let bVal: string | number = "";

        switch (sortKey) {
          case "name":
            aVal = a.name.toLowerCase();
            bVal = b.name.toLowerCase();
            break;
          case "role":
            aVal = a.role ?? "";
            bVal = b.role ?? "";
            break;
          case "lastAccessedAt":
            aVal = a.lastAccessedAt
              ? new Date(a.lastAccessedAt).getTime()
              : 0;
            bVal = b.lastAccessedAt
              ? new Date(b.lastAccessedAt).getTime()
              : 0;
            break;
          case "createdAt":
            aVal = new Date(a.createdAt).getTime();
            bVal = new Date(b.createdAt).getTime();
            break;
        }

        if (aVal < bVal) return sortDirection === "asc" ? -1 : 1;
        if (aVal > bVal) return sortDirection === "asc" ? 1 : -1;
        return 0;
      });

    const activeDrives = drives.filter((d) => !d.isTrashed);

    const favorites = sortFn(
      activeDrives.filter((d) => favoriteDriveIds.has(d.id))
    );
    const mine = sortFn(
      activeDrives.filter((d) => d.isOwned && !favoriteDriveIds.has(d.id))
    );
    const shared = sortFn(
      activeDrives.filter((d) => !d.isOwned && !favoriteDriveIds.has(d.id))
    );

    return { favoriteDrives: favorites, myDrives: mine, sharedDrives: shared };
  }, [drives, favoriteDriveIds, sortKey, sortDirection]);

  const handleDriveClick = (drive: Drive) => {
    useDriveStore.getState().setCurrentDrive(drive.id);
    useDriveStore
      .getState()
      .updateDrive(drive.id, { lastAccessedAt: new Date().toISOString() });
    fetchWithAuth(`/api/drives/${drive.id}/access`, { method: "POST" }).catch(
      (err) => console.warn("Failed to record drive access:", err)
    );
    router.push(`/dashboard/${drive.id}`);
  };

  if (isLoading && drives.length === 0) {
    return <DrivesSkeleton />;
  }

  const renderSortHeader = (key: SortKey, title: string, className?: string) => (
    <TableHead className={className}>
      <Button
        variant="ghost"
        onClick={() => handleSort(key)}
        className="px-2 py-1 h-auto"
      >
        {title}
        {sortKey === key &&
          (sortDirection === "asc" ? (
            <ArrowUp className="ml-2 h-4 w-4" />
          ) : (
            <ArrowDown className="ml-2 h-4 w-4" />
          ))}
      </Button>
    </TableHead>
  );

  const renderDriveGrid = (driveList: Drive[]) => (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
      {driveList.map((drive) => (
        <DriveContextMenu key={drive.id} drive={drive}>
          <button
            onClick={() => handleDriveClick(drive)}
            className="flex flex-col items-center justify-center p-4 border rounded-lg hover:bg-accent transition-colors aspect-square w-full text-left"
          >
            <Folder className="h-10 w-10 mb-2 text-primary" />
            <span className="text-sm font-medium text-center truncate w-full">
              {drive.name}
            </span>
            {drive.role && drive.role !== "OWNER" && (
              <span className="text-xs text-muted-foreground mt-1">
                {formatRole(drive.role)}
              </span>
            )}
            {isFavorite(drive.id, "drive") && (
              <Star className="h-3 w-3 fill-yellow-500 text-yellow-500 mt-1" />
            )}
          </button>
        </DriveContextMenu>
      ))}
    </div>
  );

  const renderDriveRows = (driveList: Drive[]) =>
    driveList.map((drive) => (
      <DriveContextMenu key={drive.id} drive={drive}>
        <TableRow
          className="cursor-pointer"
          onClick={() => handleDriveClick(drive)}
        >
          <TableCell>
            <div className="flex items-center gap-1">
              <Folder className="h-5 w-5 text-primary" />
              {isFavorite(drive.id, "drive") && (
                <Star className="h-3 w-3 fill-yellow-500 text-yellow-500" />
              )}
            </div>
          </TableCell>
          <TableCell className="font-medium">{drive.name}</TableCell>
          <TableCell className="text-sm text-muted-foreground">
            {drive.role ? formatRole(drive.role) : "—"}
          </TableCell>
          <TableCell className="text-sm text-muted-foreground">
            {drive.lastAccessedAt
              ? new Date(drive.lastAccessedAt).toLocaleDateString()
              : "—"}
          </TableCell>
          <TableCell className="text-sm text-muted-foreground">
            {new Date(drive.createdAt).toLocaleDateString()}
          </TableCell>
        </TableRow>
      </DriveContextMenu>
    ));

  const renderSectionDivider = (title: string) => (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={5} className="py-3 px-3">
        <span className="text-xs uppercase tracking-widest text-muted-foreground/60">
          {title}
        </span>
      </TableCell>
    </TableRow>
  );

  // Build the list of sections with their drives for list view
  const sections: { title: string; drives: Drive[] }[] = [
    { title: "Favorites", drives: favoriteDrives },
    { title: "My Drives", drives: myDrives },
    { title: "Shared with Me", drives: sharedDrives },
  ].filter((s) => s.drives.length > 0);

  const renderListView = () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[50px]" />
          {renderSortHeader("name", "Name")}
          {renderSortHeader("role", "Role", "w-[120px]")}
          {renderSortHeader("lastAccessedAt", "Last Accessed", "w-[150px]")}
          {renderSortHeader("createdAt", "Created", "w-[150px]")}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sections.map((section) => (
          <Fragment key={section.title}>
            {renderSectionDivider(section.title)}
            {renderDriveRows(section.drives)}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );

  const renderGridSection = (title: string, driveList: Drive[]) => {
    if (driveList.length === 0) return null;
    return (
      <div className="mb-8">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground/60 mb-3 px-1">
          {title}
        </h2>
        {renderDriveGrid(driveList)}
      </div>
    );
  };

  const noActiveDrives =
    favoriteDrives.length === 0 &&
    myDrives.length === 0 &&
    sharedDrives.length === 0;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-full">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Drives</h1>
          <div className="flex items-center gap-2">
            <Button
              variant={viewMode === "list" ? "secondary" : "ghost"}
              size="icon"
              onClick={() => setViewMode("list")}
              aria-label="List view"
            >
              <List className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === "grid" ? "secondary" : "ghost"}
              size="icon"
              onClick={() => setViewMode("grid")}
              aria-label="Grid view"
            >
              <Grip className="h-4 w-4" />
            </Button>
            <Button onClick={() => setCreateDriveOpen(true)} size="sm">
              <Plus className="h-4 w-4 mr-1" />
              New Drive
            </Button>
          </div>
        </div>

        {noActiveDrives ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Folder className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h2 className="text-lg font-medium mb-2">No drives yet</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Create your first drive to start organizing your content.
            </p>
            <Button onClick={() => setCreateDriveOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Create Drive
            </Button>
          </div>
        ) : viewMode === "grid" ? (
          <>
            {renderGridSection("Favorites", favoriteDrives)}
            {renderGridSection("My Drives", myDrives)}
            {renderGridSection("Shared with Me", sharedDrives)}
          </>
        ) : (
          renderListView()
        )}
      </div>

      <CreateDriveDialog
        isOpen={isCreateDriveOpen}
        setIsOpen={setCreateDriveOpen}
      />
    </div>
  );
}
