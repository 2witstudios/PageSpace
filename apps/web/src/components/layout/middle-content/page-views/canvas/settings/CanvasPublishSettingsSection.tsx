"use client";

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Button } from '@/components/ui/button';
import { PublishSettingsFields, EMPTY_SETTINGS, type PublishSettings } from '../../../content-header/PublishSettingsFields';
import { usePublishStatusStore } from '@/stores/usePublishStatusStore';

interface CanvasPublishSettingsSectionProps {
  pageId: string;
}

interface PublishStatusResponse {
  published: boolean;
  title?: string | null;
  description?: string | null;
  ogImageUrl?: string | null;
  noindex?: boolean;
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
 * Publish category: the author SEO overrides (title/description/share image/
 * noindex) that used to live only in a dialog gated behind the page already
 * being published. Same fields, same API — `PublishSettingsFields` — just
 * surfaced here always, disabled with an explanatory note until the page has
 * been published at least once (there's nothing to persist yet otherwise;
 * see the plan's note on this deliberate scope choice over a fuller
 * draft-settings-before-first-publish redesign).
 *
 * Reads/writes through `usePublishStatusStore`, shared with the header's
 * PublishControls — publishing/unpublishing from the header while this
 * category is open updates `published` here too, instead of this component's
 * own mount-time snapshot going stale (it previously fetched independently).
 */
export function CanvasPublishSettingsSection({ pageId }: CanvasPublishSettingsSectionProps) {
  const params = useParams<{ driveId?: string }>();
  const driveId = params?.driveId;

  const status = usePublishStatusStore((s) => s.statuses.get(pageId));
  const fetchStatus = usePublishStatusStore((s) => s.fetchStatus);
  const setStatus = usePublishStatusStore((s) => s.setStatus);

  const [form, setForm] = useState<PublishSettings>(EMPTY_SETTINGS);
  const [pickedImageId, setPickedImageId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Whether the user has touched the form since it was last seeded from
  // `status.settings`. Reseeding must skip a dirty form (so an in-progress
  // edit here survives an unrelated status change, e.g. the header marking
  // the page stale after a content save) but NOT skip a pristine one — a
  // one-shot "seeded once ever" guard would let this category keep showing
  // stale values (and silently roll them back on Save) after the header's
  // own Publish settings dialog saves different ones while this stays open.
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    fetchStatus(pageId);
  }, [pageId, fetchStatus]);

  useEffect(() => {
    if (status && !isDirty) {
      setForm({
        title: status.settings.title,
        description: status.settings.description,
        ogImageUrl: status.settings.ogImageUrl,
        noindex: status.settings.noindex,
      });
    }
  }, [status, isDirty]);

  const handleFormChange = useCallback((next: PublishSettings) => {
    setForm(next);
    setIsDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!pickedImageId) {
      const ogImageUrl = form.ogImageUrl.trim();
      if (ogImageUrl) {
        try {
          new URL(ogImageUrl);
        } catch {
          toast.error('Enter a valid share image URL, including https://');
          return;
        }
      }
    }
    setIsSaving(true);
    try {
      const res = await fetchWithAuth(`/api/pages/${pageId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          description: form.description,
          ogImageUrl: pickedImageId ? '' : form.ogImageUrl,
          ogImageFileId: pickedImageId ?? undefined,
          noindex: form.noindex,
        }),
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      const data = (await res.json()) as PublishStatusResponse & { url?: string };
      // Preserve available/url/etc from the current status rather than
      // reconstructing it from this POST response — unlike the GET status
      // shape, PublishCanvasPageResult doesn't carry `available`, and this
      // save path is only reachable once the page is already published (the
      // fields are disabled otherwise), so `available` is already correct.
      // Read fresh from the store rather than the outer `status` closure,
      // which this useCallback doesn't depend on and could be stale.
      const current = usePublishStatusStore.getState().statuses.get(pageId);
      if (!current) return;
      const nextSettings = {
        title: data.title ?? '',
        description: data.description ?? '',
        ogImageUrl: data.ogImageUrl ?? '',
        noindex: data.noindex ?? false,
        themeBridgeEnabled: data.themeBridgeEnabled ?? current.settings.themeBridgeEnabled,
      };
      setStatus(pageId, { ...current, url: data.url ?? current.url, isStale: false, settings: nextSettings });
      setForm({
        title: nextSettings.title,
        description: nextSettings.description,
        ogImageUrl: nextSettings.ogImageUrl,
        noindex: nextSettings.noindex,
      });
      setPickedImageId(null);
      // The form now matches the just-saved (and just-committed-to-the-store)
      // values, so it's pristine again — a later external status change is
      // safe to reseed from without clobbering an edit that no longer exists.
      setIsDirty(false);
      toast.success('Publish settings saved');
    } catch {
      toast.error('Failed to save publish settings');
    } finally {
      setIsSaving(false);
    }
  }, [pageId, form, pickedImageId, setStatus]);

  if (!status) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {!status.published && (
        <p className="text-sm text-muted-foreground">
          Publish this page from the header first — these settings apply once it&apos;s live.
        </p>
      )}
      <PublishSettingsFields
        value={form}
        onChange={handleFormChange}
        pickedImageId={pickedImageId}
        onPickedImageIdChange={(id) => { setPickedImageId(id); setIsDirty(true); }}
        driveId={driveId}
        disabled={!status.published}
        idPrefix="canvas-publish"
      />
      <Button onClick={handleSave} disabled={!status.published || isSaving}>
        {isSaving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}
