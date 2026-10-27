'use client';

import { useEffect, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { fetchWithAuth } from '@/retained/lib/auth/auth-fetch';

interface FormTargetSummary {
  sheetPageId: string;
  status: 'active' | 'paused' | 'archived';
}

/** The preview frame's header: what the View tab shows, and the fullscreen toggle. */
export function CanvasPreviewHeader({
  themeBridgeEnabled,
  onFullscreen,
}: {
  readonly themeBridgeEnabled: boolean;
  readonly onFullscreen: () => void;
}) {
  return (
    <div className="flex h-9 flex-none items-center gap-3 border-b px-3 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">Canvas preview</span>
      <span>{themeBridgeEnabled ? 'Matches app theme' : 'Fixed appearance'}</span>
      <span className="flex-1" />
      <button
        type="button"
        title="Fullscreen preview"
        aria-label="Fullscreen preview"
        onClick={onFullscreen}
        className="rounded-md p-1 hover:bg-muted hover:text-foreground"
      >
        <Maximize2 className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * "Wired form → <sheet> · Active" for the canvas's first non-archived form target. Renders
 * nothing when the page has no target, or when either lookup fails: no placeholder copy.
 */
export function CanvasFormTargetFooter({ pageId }: { readonly pageId: string }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLabel(null);
    const load = async () => {
      const response = await fetchWithAuth(`/api/pages/${pageId}/form-target`);
      if (!response.ok) return;
      const { formTargets } = (await response.json()) as { formTargets?: FormTargetSummary[] };
      const target = (formTargets ?? []).find((candidate) => candidate.status !== 'archived');
      if (!target) return;
      const sheetResponse = await fetchWithAuth(`/api/pages/${target.sheetPageId}`);
      if (!sheetResponse.ok) return;
      const { title } = (await sheetResponse.json()) as { title?: string | null };
      if (!title) return;
      const state = target.status === 'active' ? 'Active' : 'Paused';
      if (!cancelled) setLabel(`Wired form → ${title} · ${state}`);
    };
    load().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  if (label === null) return null;
  return (
    <div className="flex h-8 flex-none items-center border-t px-3 text-xs text-muted-foreground">{label}</div>
  );
}
