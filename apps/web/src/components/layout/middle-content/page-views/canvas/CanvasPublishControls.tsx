"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';

interface CanvasPublishControlsProps {
  pageId: string;
  /** Mirrors the canvas document's isDirty flag. When it transitions true→false
   *  (a save just completed) and the page is published, the control marks itself
   *  stale so the user sees the Update button without a page reload. */
  contentDirty?: boolean;
}

/** Author-supplied SEO overrides for a published page. */
interface PublishSettings {
  title: string;
  description: string;
  ogImageUrl: string;
  noindex: boolean;
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
}

const EMPTY_SETTINGS: PublishSettings = { title: '', description: '', ogImageUrl: '', noindex: false };

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

const CanvasPublishControls = ({ pageId, contentDirty }: CanvasPublishControlsProps) => {
  const [state, setState] = useState<PublishState>({ published: false, url: null, available: false, isStale: false, settings: EMPTY_SETTINGS });
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
          if (!cancelled) setState({ published: false, url: null, available: false, isStale: false, settings: EMPTY_SETTINGS });
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
          });
        }
      } catch {
        if (!cancelled) setState({ published: false, url: null, available: false, isStale: false, settings: EMPTY_SETTINGS });
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
  const handlePublish = useCallback(async (isUpdate = false, overrides?: PublishSettings) => {
    setIsBusy(true);
    try {
      const body = overrides
        ? JSON.stringify({
            title: overrides.title,
            description: overrides.description,
            ogImageUrl: overrides.ogImageUrl,
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
      const data = (await res.json()) as { url: string };
      setState((prev) => ({
        ...prev,
        published: true,
        url: data.url,
        available: true,
        isStale: false,
        settings: overrides ?? prev.settings,
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

  // Publishing isn't configured on this deployment (e.g. no PUBLISH_BUCKET) —
  // hide the control entirely rather than show a button that only returns 503.
  if (!state.available) {
    return null;
  }

  if (!state.published || !state.url) {
    return (
      <button
        className="px-4 py-2 text-sm disabled:opacity-50"
        onClick={() => handlePublish()}
        disabled={isBusy}
      >
        {isBusy ? 'Publishing…' : 'Publish'}
      </button>
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
            <button
              className="px-2 py-2 text-sm whitespace-nowrap disabled:opacity-50"
              onClick={() => handlePublish(true)}
              disabled={isBusy}
            >
              {isBusy ? 'Updating…' : 'Update'}
            </button>
          </>
        )}
        <button
          className="flex items-center gap-1 px-2 py-2 text-sm whitespace-nowrap"
          onClick={() => setSettingsOpen(true)}
          aria-label="Publish settings"
        >
          <Settings2 className="h-4 w-4" />
          Settings
        </button>
        <button className="px-2 py-2 text-sm whitespace-nowrap" onClick={handleCopy}>
          Copy link
        </button>
        <button
          className="px-2 py-2 text-sm whitespace-nowrap text-red-500 disabled:opacity-50"
          onClick={handleUnpublish}
          disabled={isBusy}
        >
          {isBusy ? 'Unpublishing…' : 'Unpublish'}
        </button>
      </div>

      <PublishSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initial={state.settings}
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
  isBusy: boolean;
  onSave: (settings: PublishSettings) => void;
}

function PublishSettingsDialog({ open, onOpenChange, initial, isBusy, onSave }: PublishSettingsDialogProps) {
  const [form, setForm] = useState<PublishSettings>(initial);

  // Re-seed the form from the latest persisted values whenever the dialog opens.
  useEffect(() => {
    if (open) setForm(initial);
  }, [open, initial]);

  // Validate the share-image URL client-side so the user gets a specific message
  // instead of the server's generic rejection (the route also enforces this).
  const handleSubmit = () => {
    const ogImageUrl = form.ogImageUrl.trim();
    if (ogImageUrl) {
      try {
        new URL(ogImageUrl);
      } catch {
        toast.error('Enter a valid share image URL, including https://');
        return;
      }
    }
    onSave(form);
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
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="publish-title">Title</Label>
            <Input
              id="publish-title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Defaults to the page title"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="publish-description">Description</Label>
            <Textarea
              id="publish-description"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Shown in search results and link unfurls"
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="publish-og-image">Share image URL</Label>
            <Input
              id="publish-og-image"
              type="url"
              value={form.ogImageUrl}
              onChange={(e) => setForm((f) => ({ ...f, ogImageUrl: e.target.value }))}
              placeholder="https://… (1200×630 recommended)"
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="publish-noindex">Hide from search engines</Label>
              <p className="text-xs text-muted-foreground">
                Adds a noindex tag and keeps the page out of the sitemap.
              </p>
            </div>
            <Switch
              id="publish-noindex"
              checked={form.noindex}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, noindex: checked }))}
            />
          </div>
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

export default CanvasPublishControls;
