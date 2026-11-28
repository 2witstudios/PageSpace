'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from '@/retained-adapters/navigation';
import { usePermissions } from '@/retained/hooks/usePermissions';

export type CanvasTab = 'view' | 'code' | 'settings';

export const CANVAS_TABS: readonly CanvasTab[] = ['view', 'code', 'settings'];

const isCanvasTab = (value: string | null): value is CanvasTab =>
  value !== null && (CANVAS_TABS as readonly string[]).includes(value);

/**
 * The canvas's top-level tab, held in the `?tab=` search param. Shared by the page strip's
 * tablist and the body so both read one source of truth.
 */
export function useCanvasTab(pageId: string) {
  const { permissions } = usePermissions(pageId);
  const isReadOnly = permissions?.canEdit !== true;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get('tab');
  // A stale/foreign ?tab= value (an old bookmark from before the Forms tab was
  // removed, a manually edited URL, …) must fall back to 'view' rather than
  // rendering none of the tab panels below.
  const activeTab: CanvasTab = isReadOnly && rawTab === 'settings' ? 'view' : isCanvasTab(rawTab) ? rawTab : 'view';
  const setActiveTab = useCallback((tab: CanvasTab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (tab === 'view') {
      params.delete('tab');
    } else {
      params.set('tab', tab);
    }
    // Switching top-level tab always leaves any settings category behind.
    params.delete('category');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

  return { activeTab, setActiveTab, isReadOnly };
}
