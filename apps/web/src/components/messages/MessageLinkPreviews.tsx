'use client';

import { useLinkPreview } from '@/hooks/useLinkPreview';
import { PageLinkPreview } from './PageLinkPreview';

interface MessageLinkPreviewsProps {
  content: string;
}

export function MessageLinkPreviews({ content }: MessageLinkPreviewsProps) {
  const previews = useLinkPreview(content);

  if (previews.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      {previews.map((preview) => (
        <PageLinkPreview key={preview.id} preview={preview} />
      ))}
    </div>
  );
}
