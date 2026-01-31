"use client";

import { useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { usePageStore } from '@/hooks/usePage';
import { usePageTree } from '@/hooks/usePageTree';
import { post } from '@/lib/auth/auth-fetch';

export default function Page() {
  const params = useParams();
  const setPageId = usePageStore((state) => state.setPageId);
  const pageId = params.pageId as string;
  const driveId = params.driveId as string;
  const recordedViewRef = useRef<string | null>(null);
  const { updateNode } = usePageTree(driveId);

  useEffect(() => {
    if (pageId) {
      setPageId(pageId);

      // Record page view if we haven't already for this page
      if (recordedViewRef.current !== pageId) {
        recordedViewRef.current = pageId;
        post(`/api/pages/${pageId}/view`).then(() => {
          // Clear the change indicator dot after recording the view
          updateNode(pageId, { hasChanges: false });
        }).catch(() => {
          // Silently fail - page view tracking is non-critical
        });
      }
    }
    // Cleanup: Only clear pageId when component is truly unmounting
    // Not when pageId changes, to prevent unnecessary state updates
  }, [pageId, setPageId, updateNode]);

  // Clear pageId only on component unmount
  useEffect(() => {
    return () => {
      setPageId(null);
    };
  }, [setPageId]);

  // Layout always renders CenterPanel - route pages return null for seamless navigation
  return null;
}
