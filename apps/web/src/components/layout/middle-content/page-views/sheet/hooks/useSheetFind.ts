import { useEffect, useMemo, useRef, useState } from 'react';
import type { SheetData } from '@pagespace/lib/sheets/sheet';
import { useFindStore } from '@/stores/useFindStore';
import { buildFindMatches } from '../core/find';
import type { DisplayLookup } from '../core/clipboard';

/**
 * Shell hook for find-in-sheet: subscribes to the find store, computes matches
 * with the pure `buildFindMatches`, reports the count, and scrolls the current
 * match into view. Returns the highlight set + current address for the grid.
 *
 * Revealing goes through a caller-supplied `onReveal` rather than
 * `querySelector(...).scrollIntoView()`, because in a virtualized grid a match
 * outside the rendered window has no element — which is precisely the match the
 * user needs scrolled to.
 */
export const useSheetFind = (
  sheet: SheetData,
  displayAt: DisplayLookup,
  onReveal: (address: string) => void,
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
    const matches = buildFindMatches(findQuery, sheet, displayAt);
    setFindAddresses(matches);
    reportMatches(matches.length);
  }, [isFindOpen, findQuery, sheet, displayAt, reportMatches]);

  // Guarded on the address, not on `onReveal`'s identity. `onReveal` closes over
  // the grid axes, which change on every pointer move of a resize drag — without
  // this the sheet would keep yanking itself back to the current find match
  // while the user is dragging a column edge.
  const lastRevealedRef = useRef<string | null>(null);
  useEffect(() => {
    const address = findAddresses[findIndex];
    if (!address || lastRevealedRef.current === address) return;
    lastRevealedRef.current = address;
    onReveal(address);
  }, [findIndex, findAddresses, onReveal]);

  // Reopening find on the same match should scroll to it again.
  useEffect(() => {
    if (!isFindOpen) lastRevealedRef.current = null;
  }, [isFindOpen]);

  const findAddressSet = useMemo(() => new Set(findAddresses), [findAddresses]);
  const currentFindAddress = findAddresses[findIndex] ?? null;

  return { findAddressSet, currentFindAddress };
};
