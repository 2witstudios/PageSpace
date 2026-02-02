"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Folder, MoreHorizontal, Star } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageTypeIcon } from "@/components/common/PageTypeIcon";
import { useFavorites } from "@/hooks/useFavorites";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { cn } from "@/lib/utils";
import type { PageType } from "@pagespace/lib/client-safe";
import { toast } from "sonner";

export default function FavoritesSection() {
  const router = useRouter();
  const { favorites, isLoading, isSynced, fetchFavorites, removeFavoriteById } = useFavorites();
  const isSheetBreakpoint = useBreakpoint("(max-width: 1023px)");
  const setLeftSheetOpen = useLayoutStore((state) => state.setLeftSheetOpen);

  useEffect(() => {
    if (!isSynced) {
      fetchFavorites();
    }
  }, [isSynced, fetchFavorites]);

  const handleNavigate = (href: string) => {
    router.push(href);
    if (isSheetBreakpoint) {
      setLeftSheetOpen(false);
    }
  };

  const handleRemoveFavorite = async (favoriteId: string) => {
    const toastId = toast.loading("Removing from favorites...");
    try {
      await removeFavoriteById(favoriteId);
      toast.success("Removed from favorites", { id: toastId });
    } catch {
      toast.error("Failed to remove from favorites", { id: toastId });
    }
  };

  if (isLoading && !isSynced) {
    return <FavoritesSkeleton />;
  }

  if (favorites.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1">
      <h3 className="px-2 text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium flex items-center gap-1.5">
        <Star className="h-3 w-3" />
        Favorites
      </h3>
      <div className="space-y-0.5">
        {favorites.map((favorite) => (
          <FavoriteItem
            key={favorite.id}
            favorite={favorite}
            onNavigate={handleNavigate}
            onRemove={() => handleRemoveFavorite(favorite.id)}
          />
        ))}
      </div>
    </div>
  );
}

interface FavoriteItemProps {
  favorite: {
    id: string;
    itemType: "page" | "drive";
    page?: {
      id: string;
      title: string;
      type: string;
      driveId: string;
      driveName: string;
    };
    drive?: {
      id: string;
      name: string;
    };
  };
  onNavigate: (href: string) => void;
  onRemove: () => void;
}

function FavoriteItem({ favorite, onNavigate, onRemove }: FavoriteItemProps) {
  const [isHovered, setIsHovered] = useState(false);

  const href =
    favorite.itemType === "drive" && favorite.drive
      ? `/dashboard/${favorite.drive.id}`
      : favorite.itemType === "page" && favorite.page
        ? `/dashboard/${favorite.page.driveId}/${favorite.page.id}`
        : "#";

  const title =
    favorite.itemType === "drive"
      ? favorite.drive?.name
      : favorite.page?.title;

  const subtitle =
    favorite.itemType === "page" ? favorite.page?.driveName : undefined;

  return (
    <div
      className="group relative flex items-center"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <button
        onClick={() => onNavigate(href)}
        className={cn(
          "flex items-center gap-2.5 w-full py-1.5 px-2 rounded-md text-sm transition-colors",
          "hover:bg-accent hover:text-accent-foreground",
          "text-left"
        )}
      >
        {favorite.itemType === "drive" ? (
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <PageTypeIcon
            type={(favorite.page?.type || "DOCUMENT") as PageType}
            className="h-4 w-4 shrink-0 text-muted-foreground"
          />
        )}
        <div className="flex-1 min-w-0">
          <span className="truncate block">{title}</span>
          {subtitle && (
            <span className="text-[10px] text-muted-foreground/60 truncate block">
              {subtitle}
            </span>
          )}
        </div>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "absolute right-1 h-6 w-6 transition-opacity",
              isHovered ? "opacity-100" : "opacity-0"
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            onSelect={onRemove}
            className="text-muted-foreground"
          >
            <Star className="mr-2 h-4 w-4" />
            Remove from favorites
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function FavoritesSkeleton() {
  return (
    <div className="space-y-1">
      <Skeleton className="h-3 w-16 mx-2" />
      <div className="space-y-0.5">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
      </div>
    </div>
  );
}
