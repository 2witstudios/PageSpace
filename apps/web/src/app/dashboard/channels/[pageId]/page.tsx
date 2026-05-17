'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import { Hash, ExternalLink } from 'lucide-react';
import type { Page } from '@pagespace/lib/types';
import { Button } from '@/components/ui/button';
import { ChannelView } from '@/components/layout/middle-content/page-views/channel';
import type { TreePage } from '@/hooks/usePageTree';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

export default function InboxChannelPage() {
  const params = useParams();
  const pageId = params.pageId as string;

  const { data: page, error: pageError } = useSWR<Page>(
    pageId ? `/api/pages/${pageId}` : null,
    fetcher
  );

  if (pageError) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <Hash className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-xl font-semibold mb-2">Channel not found</h2>
          <p className="text-muted-foreground">This channel may have been deleted or you don&apos;t have access.</p>
        </div>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-muted-foreground">Loading channel...</p>
        </div>
      </div>
    );
  }

  // ChannelView only reads `id` and `driveId`; it fetches its own messages
  // and tree state, so the inbox route just adapts the page record.
  const channelPage: TreePage = { ...page, children: [], aiChat: null, messages: [] };

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex-shrink-0 border-b border-border p-4">
        <div className="flex items-center justify-between max-w-4xl mx-auto">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
              <Hash className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <h2 className="font-semibold">#{page.title}</h2>
              <p className="text-sm text-muted-foreground">Channel</p>
            </div>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/dashboard/${page.driveId}/${page.id}`}>
              <ExternalLink className="h-4 w-4 mr-2" />
              Open in Drive
            </Link>
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <ChannelView page={channelPage} />
      </div>
    </div>
  );
}
