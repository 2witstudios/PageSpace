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
  const [state, setState] = useState<PublishState>({ published: false, url: null });
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const res = await fetchWithAuth(`/api/pages/${pageId}/publish`);
        if (!res.ok) {
          if (!cancelled) setState({ published: false, url: null });
          return;
        }
        const data = (await res.json()) as { published: boolean; url?: string };
        if (!cancelled) {
          setState({ published: data.published, url: data.published ? data.url ?? null : null });
        }
      } catch {
        if (!cancelled) setState({ published: false, url: null });
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  const handlePublish = useCallback(async () => {
    setIsBusy(true);
    try {
      const res = await fetchWithAuth(`/api/pages/${pageId}/publish`, { method: 'POST' });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      const data = (await res.json()) as { url: string };
      setState({ published: true, url: data.url });
      toast.success('Page published');
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
      setState({ published: false, url: null });
      setShowPreview(false);
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

  if (!state.published || !state.url) {
    return (
      <button
        className="px-4 py-2 text-sm disabled:opacity-50"
        onClick={handlePublish}
        disabled={isBusy}
      >
        {isBusy ? 'Publishing…' : 'Publish'}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2">
      <a
        href={state.url}
        target="_blank"
        rel="noreferrer"
        className="max-w-[16rem] truncate text-sm text-blue-500 hover:underline"
        title={state.url}
      >
        {state.url}
      </a>
      <button className="px-2 py-2 text-sm" onClick={handleCopy}>
        Copy link
      </button>
      <button className="px-2 py-2 text-sm" onClick={() => setShowPreview((v) => !v)}>
        {showPreview ? 'Hide preview' : 'Preview'}
      </button>
      <button
        className="px-2 py-2 text-sm text-red-500 disabled:opacity-50"
        onClick={handleUnpublish}
        disabled={isBusy}
      >
        {isBusy ? 'Unpublishing…' : 'Unpublish'}
      </button>

      {showPreview && (
        <div className="absolute right-0 top-full z-10 mt-1 h-[60vh] w-[min(40rem,90vw)] border bg-background shadow-lg">
          {/* COOP/COEP on the app + the authoritative edge CSP are the task-06 hardening; this iframe omits allow-same-origin and credentials. */}
          <iframe
            src={state.url}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            {...{ credentialless: true }}
            className="w-full h-full border-0"
            title="Published preview"
          />
        </div>
      )}
    </div>
  );
};

export default CanvasPublishControls;
