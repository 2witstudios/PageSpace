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
    toast.error(`Could not copy ${label} to clipboard`);
  }
}

function CopyableRow({ label, value, ariaLabel }: { label: string; value: string; ariaLabel: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-xs text-muted-foreground">{label}</span>
      <input
        type="text"
        readOnly
        value={value}
        aria-label={ariaLabel}
        className="flex-1 h-7 min-w-0 px-2 text-xs font-mono bg-muted rounded border border-input truncate focus:ring-2 focus:ring-ring cursor-text"
        onClick={(e) => (e.target as HTMLInputElement).select()}
      />
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 shrink-0"
        onClick={() => copyToClipboard(value, label)}
        disabled={!value}
        aria-label={`Copy ${ariaLabel}`}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
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
      <CopyableRow label="Link" value={pageUrl} ariaLabel="Page link" />
      <CopyableRow label="ID" value={pageId} ariaLabel="Page ID" />
      <p className="text-xs text-muted-foreground">
        The link opens this page for people who already have access.
      </p>
    </div>
  );
}
