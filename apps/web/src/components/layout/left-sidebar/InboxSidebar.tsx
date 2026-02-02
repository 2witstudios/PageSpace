'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, usePathname } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import { formatDistanceToNow } from 'date-fns';
import { Search, Hash, Home, Inbox } from 'lucide-react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { cn, isElectron } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { SidebarProps } from './index';
import DriveSwitcher from '@/components/layout/navbar/DriveSwitcher';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useInboxSocket } from '@/hooks/useInboxSocket';
import { isEditingActive } from '@/stores/useEditingStore';
import type { InboxItem, InboxResponse } from '@pagespace/lib';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

export default function InboxSidebar({ className }: SidebarProps) {
  const params = useParams();
  const pathname = usePathname();
  const [searchQuery, setSearchQuery] = useState('');
  const [allItems, setAllItems] = useState<InboxItem[]>([]);
  const [pagination, setPagination] = useState<{ hasMore: boolean; nextCursor: string | null } | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isElectronMac, setIsElectronMac] = useState(false);
  const isSheetBreakpoint = useBreakpoint("(max-width: 1023px)");
  const setLeftSheetOpen = useLayoutStore((state) => state.setLeftSheetOpen);

  const driveIdParams = params.driveId;
  const driveId = Array.isArray(driveIdParams) ? driveIdParams[0] : driveIdParams;

  // Build API URL based on context
  const apiUrl = driveId
    ? `/api/inbox?driveId=${driveId}&limit=20`
    : '/api/inbox?limit=20';

  // Socket integration for real-time updates
  const { hasLoadedRef } = useInboxSocket({ driveId });

  const { data, error } = useSWR<InboxResponse>(apiUrl, fetcher, {
    refreshInterval: 0, // Disable polling - socket handles updates
    isPaused: () => hasLoadedRef.current && isEditingActive(),
    onSuccess: () => { hasLoadedRef.current = true; },
    revalidateOnFocus: false,
  });

  useEffect(() => {
    if (data) {
      setAllItems(data.items);
      setPagination(data.pagination);
    }
  }, [data]);

  useEffect(() => {
    setIsElectronMac(isElectron() && /Mac/.test(navigator.platform));
  }, []);

  const loadMore = async () => {
    if (!pagination?.hasMore || !pagination?.nextCursor || isLoadingMore) return;

    setIsLoadingMore(true);
    try {
      const url = driveId
        ? `/api/inbox?driveId=${driveId}&limit=20&cursor=${pagination.nextCursor}`
        : `/api/inbox?limit=20&cursor=${pagination.nextCursor}`;
      const response = await fetchWithAuth(url);
      const moreData: InboxResponse = await response.json();

      setAllItems((prev) => [...prev, ...moreData.items]);
      setPagination(moreData.pagination);
    } catch (err) {
      console.error('Failed to load more inbox items:', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  const filteredItems = allItems.filter((item) =>
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getItemHref = (item: InboxItem) => {
    if (item.type === 'dm') {
      return `/dashboard/messages/${item.id}`;
    }
    return `/dashboard/${item.driveId}/${item.id}`;
  };

  const isItemActive = (item: InboxItem) => {
    if (item.type === 'dm') {
      return pathname?.includes(`/messages/${item.id}`);
    }
    return pathname?.includes(`/${item.id}`);
  };

  return (
    <aside
      className={cn(
        "flex h-full w-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-sidebar-foreground liquid-glass-regular rounded-tr-lg border border-[var(--separator)] shadow-[var(--shadow-elevated)] dark:shadow-none overflow-hidden",
        className
      )}
    >
      <div className="flex h-full flex-col px-3 py-3">
        {/* Drive Switcher - with Electron Mac stoplight button padding */}
        <div className={cn("mb-3", isElectronMac && isSheetBreakpoint && "pl-[60px]")}>
          <DriveSwitcher />
        </div>

        {/* Dashboard link */}
        <Link
          href="/dashboard"
          onClick={() => isSheetBreakpoint && setLeftSheetOpen(false)}
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Home className="h-4 w-4" />
          Dashboard
        </Link>

        {/* Inbox link - active */}
        <Link
          href={driveId ? `/dashboard/${driveId}/inbox` : "/dashboard/inbox"}
          onClick={() => isSheetBreakpoint && setLeftSheetOpen(false)}
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors bg-accent text-accent-foreground mb-3"
        >
          <Inbox className="h-4 w-4" />
          Inbox
        </Link>

        {/* Search */}
        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={driveId ? "Search channels..." : "Search conversations..."}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8"
          />
        </div>

        {/* Conversations List */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-1">
            {error && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                Failed to load inbox
              </div>
            )}

            {!error && filteredItems.length === 0 && !data && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                Loading...
              </div>
            )}

            {!error && filteredItems.length === 0 && data && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                {driveId ? 'No channels in this drive' : 'No conversations yet'}
              </div>
            )}

            {filteredItems.map((item) => {
              const isActive = isItemActive(item);

              return (
                <Link
                  key={`${item.type}-${item.id}`}
                  href={getItemHref(item)}
                  onClick={() => isSheetBreakpoint && setLeftSheetOpen(false)}
                  className={cn(
                    'flex items-start gap-3 p-2 rounded-lg hover:bg-accent transition-colors cursor-pointer',
                    isActive && 'bg-accent'
                  )}
                >
                  {item.type === 'dm' ? (
                    <Avatar className="h-9 w-9 flex-shrink-0">
                      <AvatarImage src={item.avatarUrl || ''} />
                      <AvatarFallback className="text-xs">
                        {item.name.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  ) : (
                    <div className="h-9 w-9 flex-shrink-0 rounded-full bg-muted flex items-center justify-center">
                      <Hash className="h-4 w-4 text-muted-foreground" />
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-sm truncate flex-1">
                        {item.type === 'channel' ? `#${item.name}` : item.name}
                      </p>
                      {item.unreadCount > 0 && (
                        <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full bg-primary text-primary-foreground text-xs font-medium">
                          {item.unreadCount}
                        </span>
                      )}
                    </div>

                    {item.lastMessageAt && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <span>
                          {formatDistanceToNow(new Date(item.lastMessageAt), {
                            addSuffix: false,
                          })}
                        </span>
                        {item.type === 'channel' && !driveId && item.driveName && (
                          <>
                            <span>·</span>
                            <span className="truncate">{item.driveName}</span>
                          </>
                        )}
                      </div>
                    )}

                    {item.lastMessagePreview && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {item.lastMessageSender && item.type === 'channel' && (
                          <span className="font-medium">{item.lastMessageSender}: </span>
                        )}
                        {item.lastMessagePreview}
                      </p>
                    )}
                  </div>
                </Link>
              );
            })}

            {/* Load More */}
            {!searchQuery && pagination?.hasMore && (
              <button
                onClick={loadMore}
                disabled={isLoadingMore}
                className="w-full p-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {isLoadingMore ? 'Loading...' : 'Load more'}
              </button>
            )}
          </div>
        </ScrollArea>
      </div>
    </aside>
  );
}
