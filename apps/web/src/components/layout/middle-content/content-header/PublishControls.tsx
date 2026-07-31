"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Settings2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { PublishSettingsFields, type PublishSettings } from './PublishSettingsFields';
import {
  usePublishStatusStore,
  publishStatusFromResponse,
  type PublishSettingsSnapshot,
} from '@/stores/usePublishStatusStore';

interface PublishControlsProps {
  pageId: string;
  /** Mirrors the page document's isDirty flag. When it transitions true→false
   *  (a save just completed) and the page is published, the control marks itself
   *  stale so the user sees the Update button without a page reload. */
  contentDirty?: boolean;
  /** 'header' (default): rendered among other populated header buttons, so
   *  staying silent when unavailable is fine. 'panel': rendered as the sole
   *  content of a dedicated tab/panel, where silence would leave a blank tab —
   *  render an explanatory message instead. */
  variant?: 'header' | 'panel';
}

/** PublishSettingsSnapshot plus a transient "picked an uploaded file"
 *  alternative to pasting a URL — resolved server-side, never persisted as
 *  its own field. */
interface PublishOverrides extends PublishSettingsSnapshot {
  ogImageFileId?: string;
}

/** What `PublishSettingsDialog` can actually produce — the shared SEO fields
 *  it renders, plus the same transient uploaded-file alternative. No
 *  `themeBridgeEnabled`: the dialog is shared across every publishable page
 *  type, and that field only means anything for canvas pages (see the
 *  Appearance category) — `PublishControls` merges in the page's current
 *  value before calling `handlePublish`. */
type PublishDialogOverrides = PublishSettings & { ogImageFileId?: string };

interface PublishStatusResponse {
  published: boolean;
  url?: string;
  available?: boolean;
  isStale?: boolean;
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

const PublishControls = ({ pageId, contentDirty, variant = 'header' }: PublishControlsProps) => {
  const params = useParams<{ driveId?: string }>();
  const driveId = params?.driveId;
  // Shared across every surface showing this page's publish state (this
  // header control, the canvas Settings tab's Publish/Appearance categories)
  // so an action taken in one is immediately reflected in the others instead
  // of each independently caching a stale snapshot from its own mount-time fetch.
  const status = usePublishStatusStore((s) => s.statuses.get(pageId));
  const fetchStatus = usePublishStatusStore((s) => s.fetchStatus);
  const setStatus = usePublishStatusStore((s) => s.setStatus);
  const [isBusy, setIsBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const prevDirtyRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    fetchStatus(pageId);
  }, [pageId, fetchStatus]);

  // When a save completes (dirty → clean), mark the published version as stale
  // so the Update button appears without requiring a page reload.
  useEffect(() => {
    if (prevDirtyRef.current === true && contentDirty === false) {
      const current = usePublishStatusStore.getState().statuses.get(pageId);
      if (current?.published) setStatus(pageId, { ...current, isStale: true });
    }
    prevDirtyRef.current = contentDirty;
  }, [contentDirty, pageId, setStatus]);

  // Publish (or re-publish) the page. `overrides`, when provided, carries the
  // author's SEO settings; omitting it preserves whatever is persisted.
  const handlePublish = useCallback(async (isUpdate = false, overrides?: PublishOverrides) => {
    setIsBusy(true);
    try {
      const body = overrides
        ? JSON.stringify({
            title: overrides.title,
            description: overrides.description,
            ogImageUrl: overrides.ogImageUrl,
            ogImageFileId: overrides.ogImageFileId,
            noindex: overrides.noindex,
            themeBridgeEnabled: overrides.themeBridgeEnabled,
          })
        : undefined;
      const res = await fetchWithAuth(`/api/pages/${pageId}/publish`, {
        method: 'POST',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body } : {}),
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return false;
      }
      const data = (await res.json()) as PublishStatusResponse & { url: string };
      const prev = usePublishStatusStore.getState().statuses.get(pageId);
      setStatus(pageId, {
        published: true,
        url: data.url,
        available: true,
        isStale: false,
        hasLoadError: false,
        // Read the effective settings back from the server rather than caching
        // the request payload: when `overrides.ogImageFileId` was set, the
        // request's `ogImageUrl` is a blank placeholder — the server resolves
        // it to the real CDN URL and returns that resolved value here.
        settings: overrides ? publishStatusFromResponse(data).settings : prev?.settings ?? publishStatusFromResponse(data).settings,
      });
      toast.success(isUpdate ? 'Page updated' : 'Page published');
      return true;
    } catch {
      toast.error('Failed to publish page');
      return false;
    } finally {
      setIsBusy(false);
    }
  }, [pageId, setStatus]);

  const handleUnpublish = useCallback(async () => {
    setIsBusy(true);
    try {
      const res = await fetchWithAuth(`/api/pages/${pageId}/publish`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      const prev = usePublishStatusStore.getState().statuses.get(pageId);
      if (prev) setStatus(pageId, { ...prev, published: false, url: null, isStale: false });
      toast.success('Page unpublished');
    } catch {
      toast.error('Failed to unpublish page');
    } finally {
      setIsBusy(false);
    }
  }, [pageId, setStatus]);

  const handleCopy = useCallback(async () => {
    if (!status?.url) return;
    try {
      await navigator.clipboard.writeText(status.url);
      toast.success('Link copied');
    } catch {
      toast.error('Failed to copy link');
    }
  }, [status?.url]);

  if (!status) {
    return <span className="px-4 py-2 text-sm text-muted-foreground">Loading…</span>;
  }

  // Publishing isn't configured on this deployment (e.g. no PUBLISH_BUCKET), or
  // this viewer lacks permission to publish (a definitive 403 — see
  // `hasLoadError` on PublishStatus for the transient-failure case, handled
  // separately). In the header (among other populated buttons) staying silent
  // is fine; in a standalone panel (the canvas Settings tab) silence would
  // leave the tab blank, so explain instead.
  if (!status.available) {
    if (variant === 'panel') {
      return (
        <p className="text-sm text-muted-foreground">
          {status.hasLoadError
            ? "Couldn't load publishing status. Try again shortly."
            : "Publishing isn't available for this page."}
        </p>
      );
    }
    return null;
  }

  if (!status.published || !status.url) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => handlePublish()}
        disabled={isBusy}
      >
        {isBusy ? 'Publishing…' : 'Publish'}
      </Button>
    );
  }

  // The dialog's SEO fields are shared across every publishable page type
  // (see PublishSettingsFields) and don't include themeBridgeEnabled, which
  // only canvas pages have any use for — see the Appearance category instead.
  const dialogSettings: PublishSettings = {
    title: status.settings.title,
    description: status.settings.description,
    ogImageUrl: status.settings.ogImageUrl,
    noindex: status.settings.noindex,
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 max-w-full">
      <a
        href={status.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 max-w-[10rem] sm:max-w-[16rem] truncate text-sm text-blue-500 hover:underline"
        title={status.url}
      >
        {status.url}
      </a>
      <div className="flex flex-wrap items-center gap-2">
        {status.isStale && (
          <>
            <span className="px-2 py-0.5 text-xs rounded-full bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 whitespace-nowrap">
              Stale
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handlePublish(true)}
              disabled={isBusy}
            >
              {isBusy ? 'Updating…' : 'Update'}
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSettingsOpen(true)}
          aria-label="Publish settings"
        >
          <Settings2 className="h-4 w-4" />
          Settings
        </Button>
        <Button variant="ghost" size="sm" onClick={handleCopy}>
          Copy link
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-red-500 hover:text-red-500"
          onClick={handleUnpublish}
          disabled={isBusy}
        >
          {isBusy ? 'Unpublishing…' : 'Unpublish'}
        </Button>
      </div>

      <PublishSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initial={dialogSettings}
        driveId={driveId}
        isBusy={isBusy}
        onSave={async (next) => {
          const ok = await handlePublish(true, { ...next, themeBridgeEnabled: status.settings.themeBridgeEnabled });
          if (ok) setSettingsOpen(false);
        }}
      />
    </div>
  );
};

interface PublishSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: PublishSettings;
  driveId?: string;
  isBusy: boolean;
  onSave: (settings: PublishDialogOverrides) => void;
}

function PublishSettingsDialog({ open, onOpenChange, initial, driveId, isBusy, onSave }: PublishSettingsDialogProps) {
  const [form, setForm] = useState<PublishSettings>(initial);
  const [pickedImageId, setPickedImageId] = useState<string | null>(null);

  // Re-seed the form from the latest persisted values whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setForm(initial);
      setPickedImageId(null);
    }
  }, [open, initial]);

  // Validate the share-image URL client-side so the user gets a specific message
  // instead of the server's generic rejection (the route also enforces this).
  // Skipped when an uploaded file was picked — that reference is resolved and
  // validated server-side, not a client-supplied URL.
  const handleSubmit = () => {
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
    // A picked file always wins over the (now-disabled) URL input. Clear the
    // stale text here rather than just leaving it disabled: a leftover
    // invalid/partial URL would otherwise still be sent to the server, which
    // validates `ogImageUrl` before it even looks at `ogImageFileId` — failing
    // the whole publish with a generic URL error despite a perfectly valid
    // file selection.
    onSave({ ...form, ogImageUrl: pickedImageId ? '' : form.ogImageUrl, ogImageFileId: pickedImageId ?? undefined });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish settings</DialogTitle>
          <DialogDescription>
            Control how this page appears in search results and link previews. Leave a field blank to use the page&apos;s own content.
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <PublishSettingsFields
            value={form}
            onChange={setForm}
            pickedImageId={pickedImageId}
            onPickedImageIdChange={setPickedImageId}
            driveId={driveId}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isBusy}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isBusy}>
            {isBusy ? 'Saving…' : 'Save & republish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default PublishControls;
