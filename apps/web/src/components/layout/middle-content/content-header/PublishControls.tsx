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
import {
  PublishSettingsFields,
  EMPTY_SETTINGS,
  type PublishSettings,
  type PublishOverrides,
} from './PublishSettingsFields';

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

interface PublishState {
  published: boolean;
  url: string | null;
  // Whether the server can publish at all (dedicated public bucket configured).
  // When false (e.g. a deployment without PUBLISH_BUCKET) the control is hidden
  // rather than offering a Publish button that only ever 503s.
  available: boolean;
  isStale: boolean;
  settings: PublishSettings;
  // True only for a transient failure to load status (network error, 5xx) —
  // distinct from `!available`, which means the status request succeeded (or
  // definitively 403'd for a read-only viewer) and reported publishing as
  // genuinely unavailable. Keeping these separate stops a blip from rendering
  // the same "isn't available" message as a real, durable unavailability
  // signal. Lives alongside `available` (rather than as its own useState) so
  // every status-fetch outcome sets both fields in one atomic update.
  hasLoadError: boolean;
}

const EMPTY_STATE: PublishState = {
  published: false,
  url: null,
  available: false,
  isStale: false,
  settings: EMPTY_SETTINGS,
  hasLoadError: false,
};

interface PublishStatusResponse {
  published: boolean;
  url?: string;
  available?: boolean;
  isStale?: boolean;
  title?: string | null;
  description?: string | null;
  ogImageUrl?: string | null;
  noindex?: boolean;
}

const settingsFromResponse = (data: PublishStatusResponse): PublishSettings => ({
  title: data.title ?? '',
  description: data.description ?? '',
  ogImageUrl: data.ogImageUrl ?? '',
  noindex: data.noindex ?? false,
});

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
  const [state, setState] = useState<PublishState>(EMPTY_STATE);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const prevDirtyRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/pages/${pageId}/publish`);
        if (!res.ok) {
          if (cancelled) return;
          // 403 means the viewer definitively lacks permission to publish —
          // a genuine unavailability signal, not a failed request. Anything
          // else (5xx, etc.) is a real load failure.
          setState({ ...EMPTY_STATE, hasLoadError: res.status !== 403 });
          return;
        }
        const data = (await res.json()) as PublishStatusResponse;
        if (!cancelled) {
          setState({
            published: data.published,
            url: data.published ? data.url ?? null : null,
            available: data.available ?? false,
            isStale: data.isStale ?? false,
            settings: settingsFromResponse(data),
            hasLoadError: false,
          });
        }
      } catch {
        if (!cancelled) {
          setState({ ...EMPTY_STATE, hasLoadError: true });
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  // When a save completes (dirty → clean), mark the published version as stale
  // so the Update button appears without requiring a page reload.
  useEffect(() => {
    if (prevDirtyRef.current === true && contentDirty === false) {
      setState(prev => prev.published ? { ...prev, isStale: true } : prev);
    }
    prevDirtyRef.current = contentDirty;
  }, [contentDirty]);

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
      setState((prev) => ({
        ...prev,
        published: true,
        url: data.url,
        available: true,
        isStale: false,
        // Read the effective settings back from the server rather than caching
        // the request payload: when `overrides.ogImageFileId` was set, the
        // request's `ogImageUrl` is a blank placeholder — the server resolves
        // it to the real CDN URL and returns that resolved value here.
        settings: overrides ? settingsFromResponse(data) : prev.settings,
      }));
      toast.success(isUpdate ? 'Page updated' : 'Page published');
      return true;
    } catch {
      toast.error('Failed to publish page');
      return false;
    } finally {
      setIsBusy(false);
    }
  }, [pageId]);

  const handleUnpublish = useCallback(async () => {
    setIsBusy(true);
    try {
      const res = await fetchWithAuth(`/api/pages/${pageId}/publish`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      setState((prev) => ({ ...prev, published: false, url: null, isStale: false }));
      toast.success('Page unpublished');
    } catch {
      toast.error('Failed to unpublish page');
    } finally {
      setIsBusy(false);
    }
  }, [pageId]);

  const handleCopy = useCallback(async () => {
    if (!state.url) return;
    try {
      await navigator.clipboard.writeText(state.url);
      toast.success('Link copied');
    } catch {
      toast.error('Failed to copy link');
    }
  }, [state.url]);

  if (isLoading) {
    return <span className="px-4 py-2 text-sm text-muted-foreground">Loading…</span>;
  }

  // Publishing isn't configured on this deployment (e.g. no PUBLISH_BUCKET), or
  // this viewer lacks permission to publish (a definitive 403 — see
  // `hasLoadError` on PublishState for the transient-failure case, handled
  // separately). In the header (among other populated buttons) staying silent
  // is fine; in a standalone panel (the canvas Settings tab) silence would
  // leave the tab blank, so explain instead.
  if (!state.available) {
    if (variant === 'panel') {
      return (
        <p className="text-sm text-muted-foreground">
          {state.hasLoadError
            ? "Couldn't load publishing status. Try again shortly."
            : "Publishing isn't available for this page."}
        </p>
      );
    }
    return null;
  }

  if (!state.published || !state.url) {
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

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 max-w-full">
      <a
        href={state.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 max-w-[10rem] sm:max-w-[16rem] truncate text-sm text-blue-500 hover:underline"
        title={state.url}
      >
        {state.url}
      </a>
      <div className="flex flex-wrap items-center gap-2">
        {state.isStale && (
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
        initial={state.settings}
        driveId={driveId}
        isBusy={isBusy}
        onSave={async (next) => {
          const ok = await handlePublish(true, next);
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
  onSave: (settings: PublishOverrides) => void;
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
