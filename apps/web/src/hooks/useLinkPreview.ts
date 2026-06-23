'use client';

import { useState, useEffect } from 'react';
import { extractPageUrls } from '@pagespace/lib/links/page-url-parser';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

export interface LinkPreviewData {
  id: string;
  title: string;
  type: string;
  driveId: string;
  driveName: string;
  snippet?: string;
  memberCount?: number;
  taskCount?: number;
}

const MAX_PREVIEWS = 5;

export async function fetchLinkPreviews(content: string): Promise<LinkPreviewData[]> {
  const urls = extractPageUrls(content);
  if (urls.length === 0) return [];

  const seen = new Set<string>();
  const unique = urls.filter(({ pageId }) => {
    if (seen.has(pageId)) return false;
    seen.add(pageId);
    return true;
  }).slice(0, MAX_PREVIEWS);

  const results = await Promise.all(
    unique.map(async ({ pageId, driveId }) => {
      try {
        const res = await fetchWithAuth('/api/link-preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pageId, driveId }),
        });
        if (!res.ok) return null;
        return (await res.json()) as LinkPreviewData;
      } catch {
        return null;
      }
    }),
  );

  return results.filter((r): r is LinkPreviewData => r !== null);
}

export function useLinkPreview(content: string): LinkPreviewData[] {
  const [previews, setPreviews] = useState<LinkPreviewData[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchLinkPreviews(content).then((data) => {
      if (!cancelled) setPreviews(data);
    });
    return () => {
      cancelled = true;
    };
  }, [content]);

  return previews;
}
