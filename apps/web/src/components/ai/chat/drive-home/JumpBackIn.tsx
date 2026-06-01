'use client';

import { useEffect, useMemo } from 'react';
import useSWR from 'swr';
import { Star } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { useFavorites } from '@/hooks/useFavorites';
import { usePageNavigation } from '@/hooks/usePageNavigation';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';
import { PageType } from '@pagespace/lib/client-safe';
import type { RecentPage } from '@/app/api/user/recents/route';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error('Failed to fetch recents');
  return response.json();
};

interface JumpItem {
  id: string;
  title: string;
  type: PageType;
  isFavorite: boolean;
}

interface JumpBackInProps {
  driveId: string;
  /** Max number of cards to show */
  limit?: number;
}

/**
 * "Jump back in" — recent and favorite pages scoped to the current drive, as
 * clickable cards. Lets a user navigate workspace content without reopening
 * the sidebar. Hidden entirely when the drive has nothing to show yet.
 */
export function JumpBackIn({ driveId, limit = 6 }: JumpBackInProps) {
  const { navigateToPage } = usePageNavigation();

  const favorites = useFavorites((s) => s.favorites);
  const fetchFavorites = useFavorites((s) => s.fetchFavorites);
  const favoritesSynced = useFavorites((s) => s.isSynced);

  useEffect(() => {
    if (!favoritesSynced) {
      void fetchFavorites();
    }
  }, [favoritesSynced, fetchFavorites]);

  const { data, isLoading } = useSWR<{ recents: RecentPage[] }>(
    `/api/user/recents?limit=${limit}&driveId=${driveId}`,
    fetcher,
    { revalidateOnFocus: false }
  );

  const items = useMemo<JumpItem[]>(() => {
    const seen = new Set<string>();
    const result: JumpItem[] = [];

    // Favorites in this drive first — they're intentional pins.
    for (const fav of favorites) {
      const page = fav.page;
      if (fav.itemType !== 'page' || !page || page.driveId !== driveId) continue;
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      result.push({ id: page.id, title: page.title, type: page.type as PageType, isFavorite: true });
    }

    // Then recents in this drive.
    for (const recent of data?.recents ?? []) {
      if (recent.driveId !== driveId || seen.has(recent.id)) continue;
      seen.add(recent.id);
      result.push({ id: recent.id, title: recent.title, type: recent.type, isFavorite: false });
    }

    return result.slice(0, limit);
  }, [favorites, data, driveId, limit]);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[58px] rounded-lg" />
        ))}
      </div>
    );
  }

  if (items.length === 0) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Jump back in
      </h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => navigateToPage(item.id, driveId)}
            className={cn(
              'group flex items-center gap-2.5 rounded-lg border border-border/60 bg-background/60 px-3 py-2.5 text-left text-sm transition-colors',
              'hover:border-border hover:bg-accent hover:text-accent-foreground'
            )}
          >
            <PageTypeIcon
              type={item.type}
              className="h-4 w-4 shrink-0 text-muted-foreground"
            />
            <span className="flex-1 truncate">{item.title}</span>
            {item.isFavorite && (
              <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />
            )}
          </button>
        ))}
      </div>
    </section>
  );
}
