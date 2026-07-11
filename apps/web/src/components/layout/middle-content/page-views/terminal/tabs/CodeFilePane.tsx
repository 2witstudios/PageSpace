"use client";

/**
 * CodeFilePane — the Code tab's main pane: fetches ONE selected file's content
 * from the machine files route (`mode=read`) and shows it in a read-only Monaco
 * (Machine page rebuild, Phase 3).
 *
 * Read-only by design — this tab views a live checkout, it does not edit it, so
 * Monaco is mounted with `readOnly` and there is no onChange/save path. Content
 * is fetched lazily: the pane only mounts once a file is actually clicked (the
 * tab renders a placeholder until then), and CodeTab keys it per file, so each
 * selection gets a clean pane rather than one that paints the previous file's
 * content under the new file's name. The route caps a single read at 2 MiB and
 * reports `truncated` when it clips a larger file; that surfaces as a banner so
 * a partial view is never mistaken for the whole file.
 *
 * BINARIES. A real working tree is full of them — images, fonts, archives,
 * `.node` addons, `__pycache__` — and the route decodes whatever it reads as
 * UTF-8, so a binary would land in Monaco as mojibake. Two guards, because
 * neither alone is enough:
 *   1. before fetching, by extension (`isBinaryFile`) — the common case, and it
 *      saves streaming up to 2 MiB off the Sprite for something unviewable;
 *   2. after fetching, by content — the extension list was written for GitHub
 *      import and misses plenty (`.pyc`, `.node`, `a.out`, `libfoo.so.1`), so we
 *      apply git's own heuristic: a NUL byte in the head of the file means
 *      binary. A flood of U+FFFD (bytes the server's decoder couldn't map) is
 *      the same conclusion by a different route.
 *
 * A checkout that has gone away is NOT an error here: the route's `reason` is
 * mapped through the shared {@link CHECKOUT_ABSENT_COPY}, so a reader never sees
 * the route's internal phrasing ("Branch machine vanished") — the same words the
 * sidebar uses, at the same moment, for the same fact.
 */

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { AlertTriangle, FileQuestion } from 'lucide-react';
import { detectLanguageFromFilename, isBinaryFile } from '@pagespace/lib/utils/language-detection';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Button } from '@/components/ui/button';
import { CHECKOUT_ABSENT_COPY, asAbsentReason, readErrorBody, type CheckoutAbsentReason } from './checkout-states';

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

type FileState =
  | { status: 'loading' }
  | { status: 'loaded'; content: string; truncated: boolean }
  | { status: 'binary' }
  | { status: 'absent'; reason: CheckoutAbsentReason }
  | { status: 'error'; message: string };

const NUL_CHAR_CODE = 0;
const REPLACEMENT_CHAR_CODE = 0xfffd;
/** Git sniffs binary-ness from the head of the file; so do we. */
const SNIFF_CHARS = 8192;
/** Above this share of undecodable bytes, calling it text is a fiction. */
const MAX_REPLACEMENT_RATIO = 0.1;

const basename = (path: string): string => path.split('/').pop() ?? path;

/**
 * Content-based binary check, for what the extension list misses. A NUL is git's
 * own tell; U+FFFD is what the server's UTF-8 decoder emits for bytes that were
 * never text to begin with.
 */
const looksBinary = (content: string): boolean => {
  const sample = content.length > SNIFF_CHARS ? content.slice(0, SNIFF_CHARS) : content;
  if (sample.length === 0) return false;
  let replacements = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === NUL_CHAR_CODE) return true;
    if (code === REPLACEMENT_CHAR_CODE) replacements += 1;
  }
  return replacements / sample.length > MAX_REPLACEMENT_RATIO;
};

export default function CodeFilePane({ machineId, projectName, branchName, path }: CodeFilePaneProps) {
  const [state, setState] = useState<FileState>({ status: 'loading' });
  // Bumped by Retry to re-run the read without changing the selected file.
  const [attempt, setAttempt] = useState(0);
  const fileName = basename(path);

  useEffect(() => {
    // Nothing useful to render for a known binary, so don't spend a read on one.
    if (isBinaryFile(fileName)) {
      setState({ status: 'binary' });
      return;
    }

    // Retry makes an in-flight read stale — this flag, flipped by the cleanup,
    // keeps a late resolver from landing on the state that replaced it. (A new
    // file gets a whole new pane: CodeTab keys us by path.)
    let cancelled = false;
    setState({ status: 'loading' });

    const load = async () => {
      try {
        const search = new URLSearchParams({ machineId, projectName, branchName, path, mode: 'read' });
        const res = await fetchWithAuth(`/api/machines/files?${search.toString()}`);
        if (cancelled) return;

        if (!res.ok) {
          const { error, reason } = readErrorBody(await res.json().catch(() => null));
          if (cancelled) return;
          // 503 + `vanished` is unambiguous: the branch's Sprite is gone, so the
          // file is unreadable because the whole checkout is. Say that, in the
          // sidebar's words. (A read's 404 is NOT usable this way — the route
          // overloads `not_found` for both "no checkout" and "no such file", so
          // it is reported as a plain file-level failure below.)
          const absent = res.status === 503 ? asAbsentReason(reason) : null;
          if (absent !== null) {
            setState({ status: 'absent', reason: absent });
            return;
          }
          throw new Error(
            res.status === 404
              ? 'This file is no longer in the checkout.'
              : error ?? `Failed to read file (${res.status})`,
          );
        }

        const body = (await res.json()) as { content?: unknown; truncated?: unknown };
        if (cancelled) return;
        if (typeof body.content !== 'string') throw new Error('Malformed file read response');
        if (looksBinary(body.content)) {
          setState({ status: 'binary' });
          return;
        }
        setState({ status: 'loaded', content: body.content, truncated: body.truncated === true });
      } catch (err) {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to read file' });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [machineId, projectName, branchName, path, fileName, attempt]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={path}>
          {path}
        </span>
        {state.status === 'loaded' && state.truncated && (
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
        {state.status === 'binary' && (
          <PaneMessage testId="binary-file">
            <FileQuestion className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{fileName} is a binary file — no preview available.</p>
          </PaneMessage>
        )}
        {state.status === 'absent' && (
          <PaneMessage testId="checkout-absent-pane">
            <p className="text-sm font-medium">{CHECKOUT_ABSENT_COPY[state.reason].title}</p>
            <p className="text-sm text-muted-foreground">{CHECKOUT_ABSENT_COPY[state.reason].description}</p>
          </PaneMessage>
        )}
        {state.status === 'error' && (
          <PaneMessage testId="file-error">
            <p className="max-w-md text-sm text-destructive">{state.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((a) => a + 1)}>
              Retry
            </Button>
          </PaneMessage>
        )}
        {state.status === 'loaded' && (
          <MonacoEditor
            value={state.content}
            readOnly
            language={detectLanguageFromFilename(fileName)}
            className="h-full"
          />
        )}
      </div>
    </div>
  );
}

function PaneMessage({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" data-testid={testId}>
      {children}
    </div>
  );
}
