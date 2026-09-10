"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useDriveStore, type Drive } from "@/hooks/useDrive";
import { useFavorites } from "@/hooks/useFavorites";
import { fetchWithAuth } from "@/lib/auth/auth-fetch";
import { ALL_DRIVES, driveFocus, focusDestinationHref } from "@/lib/dashboard/focus";

const RECENT_LIMIT = 5;

/**
 * Everything a drive picker needs that is not presentation: the three drive
 * lists, and what selecting or starring a drive does.
 *
 * Lifted out of the sidebar's DriveSwitcher so the header's crumb and the
 * sidebar open ONE picker with one definition of "recent" and one way of
 * switching drive. Recent ordering rests on `lastAccessedAt`, which is bumped
 * optimistically on select and persisted fire-and-forget; the server never
 * gates the navigation.
 */
export function useDrivePicker(query: string) {
  const router = useRouter();
  const pathname = usePathname();

  const drives = useDriveStore((state) => state.drives);
  const currentDriveId = useDriveStore((state) => state.currentDriveId);
  const setCurrentDrive = useDriveStore((state) => state.setCurrentDrive);
  const updateDrive = useDriveStore((state) => state.updateDrive);

  const driveIds = useFavorites((state) => state.driveIds);
  const addFavorite = useFavorites((state) => state.addFavorite);
  const removeFavorite = useFavorites((state) => state.removeFavorite);

  const normalizedQuery = query.toLowerCase().trim();

  const { favoriteDrives, recentDrives, allDrives } = useMemo(() => {
    const activeDrives = drives.filter((drive) => !drive.isTrashed);
    const filtered = normalizedQuery
      ? activeDrives.filter((drive) => drive.name.toLowerCase().includes(normalizedQuery))
      : activeDrives;

    const favorites = filtered.filter((drive) => driveIds.has(drive.id));

    const sortedAll = [...filtered].sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );

    const recent = sortedAll
      .filter((drive) => !driveIds.has(drive.id))
      .sort((a, b) => {
        const aTime = a.lastAccessedAt ? new Date(a.lastAccessedAt).getTime() : 0;
        const bTime = b.lastAccessedAt ? new Date(b.lastAccessedAt).getTime() : 0;
        return bTime - aTime;
      })
      .slice(0, RECENT_LIMIT);

    return { favoriteDrives: favorites, recentDrives: recent, allDrives: sortedAll };
  }, [drives, normalizedQuery, driveIds]);

  const selectDrive = useCallback(
    (drive: Drive) => {
      setCurrentDrive(drive.id);
      // Stay in the section you were in: a drive picked while looking at
      // files (or channels, tasks, calendar) opens on that drive's files.
      router.push(focusDestinationHref(pathname, driveFocus(drive.id)));
      // Optimistic, so "Recent" reorders before the server has heard about it.
      updateDrive(drive.id, { lastAccessedAt: new Date().toISOString() });
      fetchWithAuth(`/api/drives/${drive.id}/access`, { method: "POST" }).catch(() => {});
    },
    [router, pathname, setCurrentDrive, updateDrive]
  );

  /**
   * All drives is a focus like any drive: it keeps the section you are in
   * (a drive's tasks → every drive's tasks) and clears the current drive,
   * which the sidebar's DriveSwitcher would otherwise only do on the next
   * URL change.
   */
  const selectAllDrives = useCallback(() => {
    setCurrentDrive(null);
    router.push(focusDestinationHref(pathname, ALL_DRIVES));
  }, [router, pathname, setCurrentDrive]);

  const isFavorite = useCallback((driveId: string) => driveIds.has(driveId), [driveIds]);

  const toggleFavorite = useCallback(
    async (driveId: string) => {
      try {
        if (driveIds.has(driveId)) {
          await removeFavorite(driveId, "drive");
        } else {
          await addFavorite(driveId, "drive");
        }
      } catch (error) {
        console.error("Error toggling favorite:", error);
      }
    },
    [driveIds, addFavorite, removeFavorite]
  );

  return {
    favoriteDrives,
    recentDrives,
    allDrives,
    currentDriveId,
    isSearching: normalizedQuery.length > 0,
    selectDrive,
    selectAllDrives,
    isFavorite,
    toggleFavorite,
  };
}
