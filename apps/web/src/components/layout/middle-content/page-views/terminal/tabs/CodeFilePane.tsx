"use client";

/**
 * CodeFilePane — the Code tab's main pane: fetches ONE selected file's content
 * from the machine files route (`mode=read`) and shows it in a read-only Monaco
 * (Machine page rebuild, Phase 3).
 *
 * Read-only by design — this tab views a live checkout, it does not edit it, so
 * Monaco is mounted with `readOnly` and there is no onChange/save path. Content
 * is fetched lazily: the pane only mounts once a file is actually clicked (the
 * tab renders a placeholder until then), and each new selection refetches. The
 * route caps a single read at 2 MiB and reports `truncated` when it clips a
 * larger file mid-way; we surface that as a banner so a partial view is never
 * mistaken for the whole file. Language is detected from the filename so Monaco
 * highlights correctly without the server having to classify it.
 */

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { AlertTriangle } from 'lucide-react';
import { detectLanguageFromFilename } from '@pagespace/lib/utils/language-detection';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Button } from '@/components/ui/button';

// Monaco pulls the editor bundle + `window`, so it must never SSR — matches
// every other MonacoEditor mount in the app (CodePageView, DocumentView, …).
const MonacoEditor = dynamic(() => import('@/components/editors/MonacoEditor'), { ssr: false });

interface CodeFilePaneProps {
  machineId: string;
  projectName: string;
  branchName: string;
  /** Checkout-relative path of the file to show, e.g. `src/index.ts`. */
  path: string;
}

interface LoadedFile {
  content: string;
  truncated: boolean;
}

type FileState =
  | { status: 'loading' }
  | { status: 'loaded'; file: LoadedFile }
  | { status: 'error'; message: string };

const basename = (path: string): string => path.split('/').pop() ?? path;

const readErrorMessage = (body: unknown, fallback: string): string => {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const message = (body as { error: unknown }).error;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return fallback;
};

export default function CodeFilePane({ machineId, projectName, branchName, path }: CodeFilePaneProps) {
  const [state, setState] = useState<FileState>({ status: 'loading' });
  // Bumped by Retry to re-run the fetch without changing the selected file.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // A new selection (or retry) makes an in-flight read stale — the cleanup
    // flag keeps a late resolver from clobbering the current file's state.
    let cancelled = false;
    setState({ status: 'loading' });

    const load = async () => {
      try {
        const search = new URLSearchParams({ machineId, projectName, branchName, path, mode: 'read' });
        const res = await fetchWithAuth(`/api/machines/files?${search.toString()}`);
        if (cancelled) return;
        if (!res.ok) {
          const body: unknown = await res.json().catch(() => null);
          throw new Error(readErrorMessage(body, `Failed to read file (${res.status})`));
        }
        const body = (await res.json()) as { content?: unknown; truncated?: unknown };
        if (cancelled) return;
        if (typeof body.content !== 'string') throw new Error('Malformed file read response');
        setState({ status: 'loaded', file: { content: body.content, truncated: body.truncated === true } });
      } catch (err) {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to read file' });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [machineId, projectName, branchName, path, attempt]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={path}>
          {path}
        </span>
        {state.status === 'loaded' && state.file.truncated && (
          <span className="ml-auto flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <AlertTriangle className="size-3" />
            Truncated
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {state.status === 'loading' && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Loading file…</div>
        )}
        {state.status === 'error' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="max-w-md text-sm text-destructive">{state.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((a) => a + 1)}>
              Retry
            </Button>
          </div>
        )}
        {state.status === 'loaded' && (
          <MonacoEditor
            value={state.file.content}
            readOnly
            language={detectLanguageFromFilename(basename(path))}
            className="h-full"
          />
        )}
      </div>
    </div>
  );
}
