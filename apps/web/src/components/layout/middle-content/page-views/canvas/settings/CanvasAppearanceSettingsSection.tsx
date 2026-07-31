"use client";

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

interface CanvasAppearanceSettingsSectionProps {
  pageId: string;
  /** Lets the View tab's live preview reflect a save immediately, without a refetch. */
  onThemeBridgeEnabledChange: (enabled: boolean) => void;
}

interface PublishStatusResponse {
  published: boolean;
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
 */
export function CanvasAppearanceSettingsSection({ pageId, onThemeBridgeEnabledChange }: CanvasAppearanceSettingsSectionProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [published, setPublished] = useState(false);
  const [themeBridgeEnabled, setThemeBridgeEnabled] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/pages/${pageId}/publish`);
        const data = res.ok ? ((await res.json()) as PublishStatusResponse) : { published: false };
        if (cancelled) return;
        setPublished(data.published);
        setThemeBridgeEnabled(data.themeBridgeEnabled ?? true);
      } catch {
        if (!cancelled) setPublished(false);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId]);

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
      setThemeBridgeEnabled(checked);
      onThemeBridgeEnabledChange(checked);
      toast.success('Appearance settings saved');
    } catch {
      toast.error('Failed to save appearance settings');
    } finally {
      setIsSaving(false);
    }
  }, [pageId, onThemeBridgeEnabledChange]);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {!published && (
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
          checked={themeBridgeEnabled}
          onCheckedChange={handleToggle}
          disabled={!published || isSaving}
        />
      </div>
    </div>
  );
}
