"use client";

import { Button } from '@/components/ui/button';
import { useDocumentStore } from '@/stores/useDocumentStore';
import { useParams } from 'next/navigation';
import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then(res => res.json());

export function EditorToggles() {
  const { activeView, setActiveView } = useDocumentStore();
  const params = useParams();
  const pageId = params.pageId as string;
  
  // Fetch page data to determine type
  const { data: pageData } = useSWR(
    pageId ? `/api/pages/${pageId}` : null,
    fetcher
  );
  
  // Only show editor toggles for document and canvas pages
  const shouldShowToggles = pageData?.type === 'DOCUMENT' || pageData?.type === 'CANVAS';
  
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