"use client";

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { usePublishStatusStore } from '@/stores/usePublishStatusStore';

interface CanvasAppearanceSettingsSectionProps {
  pageId: string;
}

interface PublishStatusResponse {
  themeBridgeEnabled?: boolean;
}

const readError = async (res: Response): Promise<string> => {
  try {
    const data = (await res.json()) as { error?: unknown };
    return typeof data.error === 'string' ? data.error : 'Request failed';
  } catch {
    return 'Request failed';
  }
};

/**
 * Appearance category: canvas-only, so it lives separately from the generic
 * Publish category rather than inside `PublishSettingsFields` (which
 * document/sheet/code pages also use, and whose renderers hardcode
 * `injectThemeBridge: false` — the toggle would have zero effect there).
 *
 * Reads/writes through `usePublishStatusStore`, shared with the header's
 * PublishControls and the View tab's live preview (`CanvasPageView`) — saving
 * here updates every subscriber immediately, no prop callback needed.
 */
export function CanvasAppearanceSettingsSection({ pageId }: CanvasAppearanceSettingsSectionProps) {
  const status = usePublishStatusStore((s) => s.statuses.get(pageId));
  const fetchStatus = usePublishStatusStore((s) => s.fetchStatus);
  const setStatus = usePublishStatusStore((s) => s.setStatus);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetchStatus(pageId);
  }, [pageId, fetchStatus]);

  const handleToggle = useCallback(async (checked: boolean) => {
    setIsSaving(true);
    try {
      const res = await fetchWithAuth(`/api/pages/${pageId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ themeBridgeEnabled: checked }),
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      const data = (await res.json()) as PublishStatusResponse;
      const current = usePublishStatusStore.getState().statuses.get(pageId);
      if (current) {
        setStatus(pageId, {
          ...current,
          isStale: false,
          settings: { ...current.settings, themeBridgeEnabled: data.themeBridgeEnabled ?? checked },
        });
      }
      toast.success('Appearance settings saved');
    } catch {
      toast.error('Failed to save appearance settings');
    } finally {
      setIsSaving(false);
    }
  }, [pageId, setStatus]);

  if (!status) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {!status.published && (
        <p className="text-sm text-muted-foreground">
          Publish this page from the header first — this setting applies once it&apos;s live.
        </p>
      )}
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="canvas-theme-bridge">Match app theme</Label>
          <p className="text-xs text-muted-foreground">
            Follows PageSpace&apos;s light/dark mode, in both this preview and the published page.
            Turn off if this page should always look the same.
          </p>
        </div>
        <Switch
          id="canvas-theme-bridge"
          checked={status.settings.themeBridgeEnabled}
          onCheckedChange={handleToggle}
          disabled={!status.published || isSaving}
        />
      </div>
    </div>
  );
}
