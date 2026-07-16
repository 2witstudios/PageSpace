import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { SheetData } from '@pagespace/lib/sheets/sheet';
import { useFindStore } from '@/stores/useFindStore';
import { buildFindMatches } from '../core/find';

/**
 * Shell hook for find-in-sheet: subscribes to the find store, computes matches
 * with the pure `buildFindMatches`, reports the count, and scrolls the current
 * match into view. Returns the highlight set + current address for the grid.
 */
export const useSheetFind = (
  sheet: SheetData,
  display: string[][],
  gridRef: RefObject<HTMLElement | null>,
) => {
  const findQuery = useFindStore((s) => s.query);
  const findIndex = useFindStore((s) => s.currentIndex);
  const isFindOpen = useFindStore((s) => s.isOpen);
  const reportMatches = useFindStore((s) => s.reportMatches);
  const [findAddresses, setFindAddresses] = useState<string[]>([]);

  useEffect(() => {
    if (!isFindOpen || !findQuery) {
      setFindAddresses([]);
      reportMatches(0);
      return;
    }
    const matches = buildFindMatches(findQuery, sheet, display);
    setFindAddresses(matches);
    reportMatches(matches.length);
  }, [isFindOpen, findQuery, sheet, display, reportMatches]);

  useEffect(() => {
    const addr = findAddresses[findIndex];
    if (!addr || !gridRef.current) return;
    const el = gridRef.current.querySelector(`[data-cell="${addr}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [findIndex, findAddresses, gridRef]);

  const findAddressSet = useMemo(() => new Set(findAddresses), [findAddresses]);
  const currentFindAddress = findAddresses[findIndex] ?? null;

  return { findAddressSet, currentFindAddress };
};
