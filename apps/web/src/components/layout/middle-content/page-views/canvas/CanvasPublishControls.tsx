"use client";

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

interface CanvasPublishControlsProps {
  pageId: string;
}

interface PublishState {
  published: boolean;
  url: string | null;
  // Whether the server can publish at all (dedicated public bucket configured).
  // When false (e.g. a deployment without PUBLISH_BUCKET) the control is hidden
  // rather than offering a Publish button that only ever 503s.
  available: boolean;
  isStale: boolean;
}

const readError = async (res: Response): Promise<string> => {
  try {
    const data = (await res.json()) as { error?: unknown };
    return typeof data.error === 'string' ? data.error : 'Request failed';
  } catch {
    return 'Request failed';
  }
};

const CanvasPublishControls = ({ pageId }: CanvasPublishControlsProps) => {
  const [state, setState] = useState<PublishState>({ published: false, url: null, available: false, isStale: false });
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/pages/${pageId}/publish`);
        if (!res.ok) {
          if (!cancelled) setState({ published: false, url: null, available: false, isStale: false });
          return;
        }
        const data = (await res.json()) as { published: boolean; url?: string; available?: boolean; isStale?: boolean };
        if (!cancelled) {
          setState({
            published: data.published,
            url: data.published ? data.url ?? null : null,
            available: data.available ?? false,
            isStale: data.isStale ?? false,
          });
        }
      } catch {
        if (!cancelled) setState({ published: false, url: null, available: false, isStale: false });
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  const handlePublish = useCallback(async (isUpdate = false) => {
    setIsBusy(true);
    try {
      const res = await fetchWithAuth(`/api/pages/${pageId}/publish`, { method: 'POST' });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      const data = (await res.json()) as { url: string };
      setState({ published: true, url: data.url, available: true, isStale: false });
      toast.success(isUpdate ? 'Page updated' : 'Page published');
    } catch {
      toast.error('Failed to publish page');
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
    </div>
  );
};

export default CanvasPublishControls;
