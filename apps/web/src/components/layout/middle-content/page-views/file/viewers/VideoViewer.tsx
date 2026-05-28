'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { TreePage } from '@/hooks/usePageTree';

export default function VideoViewer({ page }: { page: TreePage }) {
  const [isLoading, setIsLoading] = useState(true);

  return (
    <div className="relative flex items-center justify-center h-full p-4 bg-muted/10">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        key={page.id}
        src={`/api/files/${page.id}/view`}
        poster={`/api/files/${page.id}/thumbnail`}
        controls
        preload="metadata"
        className="max-w-full max-h-full rounded-lg"
        style={{ visibility: isLoading ? 'hidden' : 'visible' }}
        onCanPlay={() => setIsLoading(false)}
        onError={() => setIsLoading(false)}
      />
    </div>
  );
}
