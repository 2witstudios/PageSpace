"use client";

import { Button } from '@/components/ui/button';
import { useDocumentStore } from '@/stores/useDocumentStore';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { PageType, isDocumentPage, isCanvasPage } from '@pagespace/lib/client-safe';
import { fetchWithAuth } from '@/lib/auth-fetch';

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

export function EditorToggles() {
  const { activeView, setActiveView } = useDocumentStore();
  const params = useParams();
  const pageId = params.pageId as string;

  // Fetch page data to determine type
  const { data: pageData } = useSWR(
    pageId ? `/api/pages/${pageId}` : null,
    fetcher,
    {
      revalidateOnFocus: false, // Don't revalidate on tab focus (prevents interruptions)
      refreshInterval: 300000, // 5 minutes (prevents unnecessary polling)
    }
  );
  
  // Only show editor toggles for document and canvas pages
  const pageType = pageData?.type as PageType;
  const shouldShowToggles = pageType && (isDocumentPage(pageType) || isCanvasPage(pageType));
  
  if (!shouldShowToggles) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant={activeView === 'rich' ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setActiveView('rich')}
      >
        Rich
      </Button>
      <Button
        variant={activeView === 'code' ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setActiveView('code')}
      >
        Code
      </Button>
    </div>
  );
}