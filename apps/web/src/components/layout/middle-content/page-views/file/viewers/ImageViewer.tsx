'use client';

import { useState, useEffect } from 'react';
import { TreePage } from '@/hooks/usePageTree';
import { Loader2 } from 'lucide-react';

interface ImageViewerProps {
  page: TreePage;
}

export default function ImageViewer({ page }: ImageViewerProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
  }, [page.id]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="relative flex items-center justify-center h-full p-4 bg-muted/10">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={page.id}
        src={`/api/files/${page.id}/view`}
        alt={page.title}
        className="max-w-full max-h-full object-contain"
        style={{ imageRendering: 'auto', visibility: isLoading ? 'hidden' : 'visible' }}
        onLoad={() => setIsLoading(false)}
        onError={() => {
          setIsLoading(false);
          setError('Failed to load image');
        }}
      />
    </div>
  );
}
