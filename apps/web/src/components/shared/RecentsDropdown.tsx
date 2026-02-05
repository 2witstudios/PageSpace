"use client";

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { Clock, Loader2 } from 'lucide-react';
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
import type { PageType } from '@pagespace/lib/client-safe';
import type { RecentPage } from '@/app/api/user/recents/route';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error('Failed to fetch');
  return response.json();
};

interface RecentsDropdownProps {
  className?: string;
}

export default function RecentsDropdown({ className }: RecentsDropdownProps) {
  const router = useRouter();

  const { data, isLoading } = useSWR<{ recents: RecentPage[] }>(
    '/api/user/recents?limit=10',
    fetcher,
    {
      refreshInterval: 5 * 60 * 1000, // 5 minutes
      revalidateOnFocus: false,
    }
  );

  const handleNavigate = useCallback((page: RecentPage) => {
    router.push(`/dashboard/${page.driveId}/${page.id}`);
  }, [router]);

  const recents = data?.recents ?? [];

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
          <div className="px-2 py-4 flex justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : recents.length === 0 ? (
          <div className="px-2 py-4 text-sm text-muted-foreground text-center">
            No recent pages
          </div>
        ) : (
          recents.map((page) => (
            <DropdownMenuItem
              key={page.id}
              onClick={() => handleNavigate(page)}
              className="cursor-pointer"
            >
              <PageTypeIcon
                type={page.type as PageType}
                className="mr-2 h-4 w-4 flex-shrink-0"
              />
              <span className="truncate">{page.title}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
