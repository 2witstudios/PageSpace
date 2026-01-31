"use client";

import { useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { usePageStore } from '@/hooks/usePage';
import { post } from '@/lib/auth/auth-fetch';

export default function Page() {
  const params = useParams();
  const setPageId = usePageStore((state) => state.setPageId);
  const pageId = params.pageId as string;
  const recordedViewRef = useRef<string | null>(null);

  useEffect(() => {
    if (pageId) {
      setPageId(pageId);

      // Record page view if we haven't already for this page
      if (recordedViewRef.current !== pageId) {
        recordedViewRef.current = pageId;
        post(`/api/pages/${pageId}/view`).catch(() => {
          // Silently fail - page view tracking is non-critical
        });
      }
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
