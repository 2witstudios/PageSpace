"use client";

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { usePageStore } from '@/hooks/usePage';

export default function Page() {
  const params = useParams();
  const setPageId = usePageStore((state) => state.setPageId);
  const pageId = params.pageId as string;

  useEffect(() => {
    if (pageId) {
      setPageId(pageId);
    }
    // Cleanup: Only clear pageId when component is truly unmounting
    // Not when pageId changes, to prevent unnecessary state updates
  }, [pageId, setPageId]);

  // Clear pageId only on component unmount
  useEffect(() => {
    return () => {
      setPageId(null);
    };
  }, [setPageId]);

  // Layout always renders CenterPanel - route pages return null for seamless navigation
  return null;
}
