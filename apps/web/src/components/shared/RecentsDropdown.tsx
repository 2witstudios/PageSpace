"use client";

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { cn } from '@/lib/utils';
import type { RecentPage } from '@/app/api/user/recents/route';

interface RecentsDropdownProps {
  className?: string;
}

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error('Failed to fetch recents');
  }
  return response.json();
};

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function RecentsDropdown({ className }: RecentsDropdownProps) {
  const router = useRouter();
  const { data, isLoading, error, mutate } = useSWR<{ recents: RecentPage[] }>(
    '/api/user/recents?limit=8',
    fetcher,
    {
      refreshInterval: 5 * 60 * 1000,
      revalidateOnFocus: false,
    }
  );

  const handleNavigate = useCallback((page: RecentPage) => {
    router.push(`/dashboard/${page.driveId}/${page.id}`);
  }, [router]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("relative", className)}
          aria-label="Recent pages"
        >
          <Clock className="h-5 w-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align="end" forceMount>
        <DropdownMenuLabel>Recent Pages</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {isLoading ? (
          <div className="px-2 py-4 text-sm text-muted-foreground text-center">
            Loading...
          </div>
        ) : error ? (
          <div className="px-2 py-4 text-sm text-center">
            <p className="text-destructive">Failed to load recent pages</p>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 mt-1 text-xs"
              onClick={() => void mutate()}
            >
              Retry
            </Button>
          </div>
        ) : !data?.recents || data.recents.length === 0 ? (
          <div className="px-2 py-4 text-sm text-muted-foreground text-center">
            No recent pages
          </div>
        ) : (
          data.recents.map((page) => {
            return (
              <DropdownMenuItem
                key={page.id}
                onSelect={() => handleNavigate(page)}
                className="cursor-pointer"
              >
                <PageTypeIcon
                  type={page.type}
                  className="mr-2 h-4 w-4 flex-shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">{page.title}</span>
                <span className="ml-2 text-[10px] text-muted-foreground/70">
                  {formatRelativeTime(page.viewedAt)}
                </span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
