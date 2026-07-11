"use client";

/**
 * CodeFilePane — the Code tab's main pane: fetches ONE selected file's content
 * from the machine files route (`mode=read`) and shows it in a read-only Monaco
 * (Machine page rebuild, Phase 3).
 *
 * Read-only by design — this tab views a live checkout, it does not edit it, so
 * Monaco is mounted with `readOnly` and there is no onChange/save path. Content
 * is fetched lazily: the pane only mounts once a file is actually clicked (the
 * tab renders a placeholder until then), and every settled state carries the
 * path it settled for, so the pane can never paint one file's content under
 * another's name. The route caps a single read at 2 MiB and reports `truncated`
 * when it clips a larger file; that surfaces as a banner so a partial view is
 * never mistaken for the whole file. The working tree is LIVE (an agent terminal
 * can rewrite the open file), and re-clicking the same row in the tree is a
 * no-op, so the header carries a reload.
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
 * mapped through the shared {@link CHECKOUT_ABSENT_COPY}, so the pane says the
 * same words the sidebar says, at the same moment, about the same fact. The
 * route keeps `not_found`/`vanished` (this branch has no checkout) distinct from
 * `file_not_found` (the checkout is fine; that one file is gone), so we can tell
 * the reader which of the two actually happened instead of guessing.
 */

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { AlertTriangle, FileQuestion, RefreshCw } from 'lucide-react';
import { detectLanguageFromFilename, isBinaryFile } from '@pagespace/lib/utils/language-detection';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { Button } from '@/components/ui/button';
import { PaneLoading, PaneNotice } from './tab-states';
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

/**
 * Every settled state carries the path it settled FOR. The pane is re-rendered
 * with a new `path` one frame before its effect can react, so rendering must ask
 * "is this state about the file I'm being asked to show?" — otherwise it paints
 * the previous file's content under the new file's name. Keying the whole
 * component by path would also fix that, but at the cost of tearing down and
 * recreating Monaco on every single file click.
 */
type FileState =
  | { status: 'loading' }
  | { status: 'loaded'; path: string; content: string; truncated: boolean }
  | { status: 'binary'; path: string }
  | { status: 'absent'; path: string; reason: CheckoutAbsentReason }
  | { status: 'error'; path: string; message: string };

const NUL_CHAR_CODE = 0;
const REPLACEMENT_CHAR_CODE = 0xfffd;
/** Git sniffs binary-ness from the head of the file; so do we. */
const SNIFF_CHARS = 8192;
/** Above this share of undecodable bytes, calling it text is a fiction. */
const MAX_REPLACEMENT_RATIO = 0.1;
/**
 * …but a ratio alone convicts short files unfairly. `Café Résumé` saved as
 * Latin-1 is 11 characters, 3 of them undecodable — 27%, over any sane ratio —
 * while the same file at 100 KB sits near 3% and renders fine. Requiring an
 * absolute count too means a legacy-encoded one-liner is still shown (with a few
 * mojibake glyphs, which is the honest rendering) instead of being declared
 * binary and hidden.
 */
const MIN_REPLACEMENTS = 8;

const basename = (path: string): string => path.split('/').pop() ?? path;

/**
 * Content-based binary check, for what the extension list misses. A NUL is git's
 * own tell; a FLOOD of U+FFFD is what the server's UTF-8 decoder leaves behind
 * for bytes that were never text to begin with.
 */
const looksBinary = (content: string): boolean => {
  const sample = content.length > SNIFF_CHARS ? content.slice(0, SNIFF_CHARS) : content;
  let replacements = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === NUL_CHAR_CODE) return true;
    if (code === REPLACEMENT_CHAR_CODE) replacements += 1;
  }
  return replacements >= MIN_REPLACEMENTS && replacements / sample.length > MAX_REPLACEMENT_RATIO;
};

export default function CodeFilePane({ machineId, projectName, branchName, path }: CodeFilePaneProps) {
  const [state, setState] = useState<FileState>({ status: 'loading' });
  // Bumped by Retry to re-run the read without changing the selected file.
  const [attempt, setAttempt] = useState(0);
  const fileName = basename(path);

  useEffect(() => {
    // Nothing useful to render for a known binary, so don't spend a read on one.
    if (isBinaryFile(fileName)) {
      setState({ status: 'binary', path });
      return;
    }

    // A new file, a Retry, or a Refresh makes an in-flight read stale — this
    // flag, flipped by the cleanup, keeps a late resolver from landing on the
    // state that replaced it.
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
          // The route keeps "this branch has no checkout" (`not_found`/`vanished`)
          // and "that one file is gone" (`file_not_found`) as distinct reasons, so
          // we can tell the reader which actually happened instead of guessing.
          const absent = asAbsentReason(reason);
          if (absent !== null) {
            setState({ status: 'absent', path, reason: absent });
            return;
          }
          throw new Error(
            reason === 'file_not_found'
              ? 'This file is no longer in the checkout.'
              : error ?? `Failed to read file (${res.status})`,
          );
        }

        const body = (await res.json()) as { content?: unknown; truncated?: unknown };
        if (cancelled) return;
        if (typeof body.content !== 'string') throw new Error('Malformed file read response');
        if (looksBinary(body.content)) {
          setState({ status: 'binary', path });
          return;
        }
        setState({ status: 'loaded', path, content: body.content, truncated: body.truncated === true });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: 'error',
          path,
          message: err instanceof Error ? err.message : 'Failed to read file',
        });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [machineId, projectName, branchName, path, fileName, attempt]);

  // The state of a DIFFERENT file is not this file's state — until the effect
  // catches up, we have nothing to show but the spinner. (See FileState.)
  const current: FileState = state.status === 'loading' || state.path === path ? state : { status: 'loading' };
  const reload = () => setAttempt((a) => a + 1);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={path}>
          {path}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {current.status === 'loaded' && current.truncated && (
            <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <AlertTriangle className="size-3" />
              Truncated
            </span>
          )}
          {/* The working tree is LIVE — an agent terminal can rewrite this file
              while it's open — and re-clicking the same row in the tree is a
              no-op, so without this there is no way to re-read what's on screen. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5"
            title="Reload file"
            onClick={reload}
          >
            <RefreshCw className="size-3" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {current.status === 'loading' && <PaneLoading message="Loading file…" />}
        {current.status === 'binary' && (
          <PaneNotice
            testId="binary-file"
            icon={<FileQuestion className="size-6 text-muted-foreground" />}
            title={`${fileName} is a binary file`}
            description="No preview available."
          />
        )}
        {current.status === 'absent' && (
          <PaneNotice
            testId="checkout-absent-pane"
            title={CHECKOUT_ABSENT_COPY[current.reason].title}
            description={CHECKOUT_ABSENT_COPY[current.reason].description}
          />
        )}
        {current.status === 'error' && (
          <PaneNotice
            testId="file-error"
            tone="destructive"
            title={current.message}
            actionLabel="Retry"
            onAction={reload}
          />
        )}
        {current.status === 'loaded' && (
          <MonacoEditor
            value={current.content}
            readOnly
            language={detectLanguageFromFilename(fileName)}
            className="h-full"
          />
        )}
      </div>
    </div>
  );
}
