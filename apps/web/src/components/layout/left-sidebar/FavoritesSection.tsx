"use client";

import { useEffect, useState, useCallback, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ExternalLink, Folder, MoreHorizontal, Star } from "lucide-react";
import { useTabsStore } from "@/stores/useTabsStore";
import { shouldOpenInNewTab } from "@/lib/tabs/tab-navigation-utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { useCapacitor } from "@/hooks/useCapacitor";
import { cn } from "@/lib/utils";
import type { PageType } from "@pagespace/lib/client-safe";
import { toast } from "sonner";

export default function FavoritesSection() {
  const router = useRouter();
  const { favorites, isLoading, isSynced, fetchFavorites, removeFavoriteById } = useFavorites();
  const isSheetBreakpoint = useBreakpoint("(max-width: 1023px)");
  const setLeftSheetOpen = useLayoutStore((state) => state.setLeftSheetOpen);
  const favoritesCollapsed = useLayoutStore((state) => state.favoritesCollapsed);
  const setFavoritesCollapsed = useLayoutStore((state) => state.setFavoritesCollapsed);
  const createTab = useTabsStore((state) => state.createTab);
  const { isNative } = useCapacitor();

  useEffect(() => {
    if (!isSynced) {
      fetchFavorites();
    }
  }, [isSynced, fetchFavorites]);

  const handleNavigate = useCallback((href: string, e?: MouseEvent) => {
    if (e && shouldOpenInNewTab(e)) {
      e.preventDefault();
      createTab({ path: href });
      return;
    }

    router.push(href);
    if (isSheetBreakpoint) {
      setLeftSheetOpen(false);
    }
  }, [router, isSheetBreakpoint, setLeftSheetOpen, createTab]);

  const handleOpenInNewTab = useCallback((href: string) => {
    createTab({ path: href });
  }, [createTab]);

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

  return (
    <Collapsible
      open={!favoritesCollapsed}
      onOpenChange={(open) => setFavoritesCollapsed(!open)}
      className="border-t border-[var(--separator)]"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between px-2 py-2 h-auto font-normal text-muted-foreground hover:text-foreground"
        >
          <span className="text-xs font-medium flex items-center gap-1.5">
            <Star className="h-3.5 w-3.5" />
            Favorites
          </span>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform duration-200",
              !favoritesCollapsed && "rotate-180"
            )}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-1">
        {favorites.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground/50">No favorites yet</p>
        ) : (
          <div className="space-y-0.5">
            {favorites.map((favorite) => {
              const href =
                favorite.itemType === "drive" && favorite.drive
                  ? `/dashboard/${favorite.drive.id}`
                  : favorite.itemType === "page" && favorite.page
                    ? `/dashboard/${favorite.page.driveId}/${favorite.page.id}`
                    : "#";
              return (
                <FavoriteItem
                  key={favorite.id}
                  favorite={favorite}
                  onNavigate={(e) => handleNavigate(href, e)}
                  onOpenInNewTab={() => handleOpenInNewTab(href)}
                  onRemove={() => handleRemoveFavorite(favorite.id)}
                  isNative={isNative}
                />
              );
            })}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
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
  onNavigate: (e: MouseEvent<HTMLButtonElement>) => void;
  onOpenInNewTab: () => void;
  onRemove: () => void;
  isNative: boolean;
}

function FavoriteItem({ favorite, onNavigate, onOpenInNewTab, onRemove, isNative }: FavoriteItemProps) {
  const [isHovered, setIsHovered] = useState(false);

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
        onClick={onNavigate}
        onAuxClick={isNative ? undefined : (e) => {
          if (e.button === 1) {
            e.preventDefault();
            onOpenInNewTab();
          }
        }}
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
          {!isNative && (
            <DropdownMenuItem onSelect={onOpenInNewTab}>
              <ExternalLink className="mr-2 h-4 w-4" />
              Open in new tab
            </DropdownMenuItem>
          )}
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
    <div className="border-t border-[var(--separator)]">
      <div className="flex items-center justify-between px-2 py-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-3.5 w-3.5" />
      </div>
      <div className="space-y-0.5 pb-1">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
      </div>
    </div>
  );
}
