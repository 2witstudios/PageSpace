"use client";

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Button } from '@/components/ui/button';
import {
  PublishSettingsFields,
  EMPTY_SETTINGS,
  type PublishSettings,
} from '../../../content-header/PublishSettingsFields';

interface CanvasPublishSettingsSectionProps {
  pageId: string;
}

interface PublishStatusResponse {
  published: boolean;
  title?: string | null;
  description?: string | null;
  ogImageUrl?: string | null;
  noindex?: boolean;
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
 */
export function CanvasPublishSettingsSection({ pageId }: CanvasPublishSettingsSectionProps) {
  const params = useParams<{ driveId?: string }>();
  const driveId = params?.driveId;

  const [isLoading, setIsLoading] = useState(true);
  const [published, setPublished] = useState(false);
  const [form, setForm] = useState<PublishSettings>(EMPTY_SETTINGS);
  const [pickedImageId, setPickedImageId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/pages/${pageId}/publish`);
        const data = res.ok ? ((await res.json()) as PublishStatusResponse) : { published: false };
        if (cancelled) return;
        setPublished(data.published);
        setForm({
          title: data.title ?? '',
          description: data.description ?? '',
          ogImageUrl: data.ogImageUrl ?? '',
          noindex: data.noindex ?? false,
        });
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
      const data = (await res.json()) as PublishStatusResponse;
      setForm({
        title: data.title ?? '',
        description: data.description ?? '',
        ogImageUrl: data.ogImageUrl ?? '',
        noindex: data.noindex ?? false,
      });
      setPickedImageId(null);
      toast.success('Publish settings saved');
    } catch {
      toast.error('Failed to save publish settings');
    } finally {
      setIsSaving(false);
    }
  }, [pageId, form, pickedImageId]);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {!published && (
        <p className="text-sm text-muted-foreground">
          Publish this page from the header first — these settings apply once it&apos;s live.
        </p>
      )}
      <PublishSettingsFields
        value={form}
        onChange={setForm}
        pickedImageId={pickedImageId}
        onPickedImageIdChange={setPickedImageId}
        driveId={driveId}
        disabled={!published}
        idPrefix="canvas-publish"
      />
      <Button onClick={handleSave} disabled={!published || isSaving}>
        {isSaving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}
