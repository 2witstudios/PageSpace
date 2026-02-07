"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronsUpDown, Folder, Plus, Search, Star } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import { useDriveStore, type Drive } from "@/hooks/useDrive";
import { useFavorites } from "@/hooks/useFavorites";
import CreateDriveDialog from "@/components/layout/left-sidebar/CreateDriveDialog";
import { cn } from "@/lib/utils";

export default function DriveSwitcher() {
  const router = useRouter();
  const params = useParams();
  const [searchQuery, setSearchQuery] = useState("");
  const [isCreateDriveOpen, setCreateDriveOpen] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  // Drive store
  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  const isLoading = useDriveStore((state) => state.isLoading);
  const currentDriveId = useDriveStore((state) => state.currentDriveId);
  const setCurrentDrive = useDriveStore((state) => state.setCurrentDrive);

  const { isFavorite, addFavorite, removeFavorite, fetchFavorites, isSynced, driveIds } = useFavorites();

  const { driveId } = params;
  const urlDriveId = Array.isArray(driveId) ? driveId[0] : driveId;

  useEffect(() => {
    fetchDrives();
  }, [fetchDrives]);

  useEffect(() => {
    if (!isSynced) {
      fetchFavorites();
    }
  }, [isSynced, fetchFavorites]);

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

  // Filter and organize drives
  const { favoriteDrives, recentDrives, allDrives } = useMemo(() => {
    const activeDrives = drives.filter((d) => !d.isTrashed);
    const query = searchQuery.toLowerCase().trim();

    // Filter by search query
    const filtered = query
      ? activeDrives.filter((d) => d.name.toLowerCase().includes(query))
      : activeDrives;

    // Favorite drives
    const favorites = filtered.filter((d) => driveIds.has(d.id));

    // Sort all drives alphabetically
    const sortedAll = [...filtered].sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );

    // Recent drives - use most recently accessed (for now just take first 5 non-favorites)
    // TODO: Track actual recent drive access
    const recent = sortedAll.filter((d) => !driveIds.has(d.id)).slice(0, 5);

    return {
      favoriteDrives: favorites,
      recentDrives: recent,
      allDrives: sortedAll,
    };
  }, [drives, searchQuery, driveIds]);

  const handleSelectDrive = (drive: Drive) => {
    setCurrentDrive(drive.id);
    router.push(`/dashboard/${drive.id}`);
    setIsOpen(false);
    setSearchQuery("");
  };

  const handleToggleFavorite = async (e: React.MouseEvent, drive: Drive) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      if (isFavorite(drive.id, 'drive')) {
        await removeFavorite(drive.id, 'drive');
      } else {
        await addFavorite(drive.id, 'drive');
      }
    } catch (error) {
      console.error('Error toggling favorite:', error);
    }
  };

  if (isLoading) {
    return <Skeleton className="h-9 w-40" />;
  }

  return (
    <>
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="flex items-center gap-2 px-2 h-9 max-w-[200px]"
          >
            <Folder className="h-4 w-4 shrink-0" />
            <span className="truncate font-medium">
              {currentDrive ? currentDrive.name : "Select Drive"}
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64" align="start">
          {/* Search */}
          <div className="p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search drives..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 pl-8"
                autoFocus
              />
            </div>
          </div>

          <DropdownMenuSeparator />

          <CustomScrollArea className="max-h-[320px] overflow-x-hidden">
            {/* Favorites Section */}
            {favoriteDrives.length > 0 && (
              <>
                <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/60 px-2 py-1.5">
                  Favorites
                </DropdownMenuLabel>
                <DropdownMenuGroup>
                  {favoriteDrives.map((drive) => (
                    <DriveMenuItem
                      key={drive.id}
                      drive={drive}
                      isActive={drive.id === currentDriveId}
                      isFavorite={true}
                      onSelect={() => handleSelectDrive(drive)}
                      onToggleFavorite={(e) => handleToggleFavorite(e, drive)}
                    />
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
              </>
            )}

            {/* Recent Section */}
            {recentDrives.length > 0 && !searchQuery && (
              <>
                <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/60 px-2 py-1.5">
                  Recent
                </DropdownMenuLabel>
                <DropdownMenuGroup>
                  {recentDrives.map((drive) => (
                    <DriveMenuItem
                      key={drive.id}
                      drive={drive}
                      isActive={drive.id === currentDriveId}
                      isFavorite={false}
                      onSelect={() => handleSelectDrive(drive)}
                      onToggleFavorite={(e) => handleToggleFavorite(e, drive)}
                    />
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
              </>
            )}

            {/* All Drives Section */}
            <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/60 px-2 py-1.5">
              {searchQuery ? "Results" : "All Drives"}
            </DropdownMenuLabel>
            <DropdownMenuGroup>
              {allDrives.length > 0 ? (
                allDrives.map((drive) => (
                  <DriveMenuItem
                    key={drive.id}
                    drive={drive}
                    isActive={drive.id === currentDriveId}
                    isFavorite={isFavorite(drive.id, 'drive')}
                    onSelect={() => handleSelectDrive(drive)}
                    onToggleFavorite={(e) => handleToggleFavorite(e, drive)}
                  />
                ))
              ) : (
                <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                  {searchQuery ? "No drives found" : "No drives yet"}
                </div>
              )}
            </DropdownMenuGroup>
          </CustomScrollArea>

          <DropdownMenuSeparator />

          {/* Create Drive */}
          <DropdownMenuItem
            onSelect={() => {
              setIsOpen(false);
              setCreateDriveOpen(true);
            }}
            className="gap-2"
          >
            <Plus className="h-4 w-4" />
            Create Drive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateDriveDialog isOpen={isCreateDriveOpen} setIsOpen={setCreateDriveOpen} />
    </>
  );
}

interface DriveMenuItemProps {
  drive: Drive;
  isActive: boolean;
  isFavorite: boolean;
  onSelect: () => void;
  onToggleFavorite: (e: React.MouseEvent) => void;
}

function DriveMenuItem({
  drive,
  isActive,
  isFavorite,
  onSelect,
  onToggleFavorite,
}: DriveMenuItemProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={cn(
        "flex items-center gap-2 pr-2 cursor-pointer",
        isActive && "bg-accent"
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <Folder className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate">{drive.name}</span>
      <button
        onClick={onToggleFavorite}
        className={cn(
          "h-6 w-6 flex items-center justify-center rounded-sm transition-opacity",
          isHovered || isFavorite ? "opacity-100" : "opacity-0",
          "hover:bg-accent"
        )}
      >
        <Star
          className={cn(
            "h-3.5 w-3.5",
            isFavorite ? "fill-yellow-500 text-yellow-500" : "text-muted-foreground"
          )}
        />
      </button>
    </DropdownMenuItem>
  );
}
