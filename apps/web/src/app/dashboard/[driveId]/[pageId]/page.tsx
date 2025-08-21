"use client";

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { usePageStore } from '@/hooks/usePage';
import CenterPanel from '@/components/layout/middle-content';

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

  return <CenterPanel />;
}