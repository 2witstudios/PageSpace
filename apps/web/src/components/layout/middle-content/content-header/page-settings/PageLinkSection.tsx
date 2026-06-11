'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';

interface PageLinkSectionProps {
  pageId: string;
  driveId: string;
}

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  } catch {
    toast.error(`Could not copy ${label.toLowerCase()} to clipboard`);
  }
}

export function PageLinkSection({ pageId, driveId }: PageLinkSectionProps) {
  // window is read in an effect so the dialog renders identically on server and client
  const [origin, setOrigin] = useState('');
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const pageUrl = origin ? `${origin}/dashboard/${driveId}/${pageId}` : '';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="w-8 shrink-0 text-xs text-muted-foreground">Link</span>
        <input
          type="text"
          readOnly
          value={pageUrl}
          aria-label="Page link"
          className="flex-1 h-7 min-w-0 px-2 text-xs font-mono bg-muted rounded border border-input truncate focus:ring-2 focus:ring-ring cursor-text"
          onClick={(e) => (e.target as HTMLInputElement).select()}
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 shrink-0"
          onClick={() => copyToClipboard(pageUrl, 'Page link')}
          disabled={!pageUrl}
          aria-label="Copy page link"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-8 shrink-0 text-xs text-muted-foreground">ID</span>
        <input
          type="text"
          readOnly
          value={pageId}
          aria-label="Page ID"
          className="flex-1 h-7 min-w-0 px-2 text-xs font-mono bg-muted rounded border border-input truncate focus:ring-2 focus:ring-ring cursor-text"
          onClick={(e) => (e.target as HTMLInputElement).select()}
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 shrink-0"
          onClick={() => copyToClipboard(pageId, 'Page ID')}
          aria-label="Copy page ID"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        The link opens this page for people who already have access.
      </p>
    </div>
  );
}
