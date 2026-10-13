'use client';

import { useEffect, useState } from 'react';
import type { ApiClient } from '@/api/client';
import { resultsFrom, type PaletteResult } from '../palette-search/palette-search';

export type PaletteSearch = {
  readonly status: 'idle' | 'loading' | 'done' | 'error';
  readonly results: readonly PaletteResult[];
};

/** The pause after the last keystroke before the palette asks. */
export const SEARCH_DELAY_MS = 150;

type Answer = { readonly path: string; readonly search: PaletteSearch };

const IDLE: PaletteSearch = { status: 'idle', results: [] };
const LOADING: PaletteSearch = { status: 'loading', results: [] };

/**
 * The server's answer for one search path. It asks once typing pauses, and
 * a new path aborts the request still in flight for the old one. An answer
 * is kept with the path it was asked for and shown only while that path is
 * still the current one, so an answer that arrives late can never replace a
 * newer one; until the current path answers, nothing is listed.
 */
export function usePaletteSearch(
  path: string | null,
  { client, delayMs = SEARCH_DELAY_MS }: { readonly client: ApiClient; readonly delayMs?: number },
): PaletteSearch {
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      client.apiFetch(path, { signal: controller.signal }).then(
        (body) => {
          if (!controller.signal.aborted) setAnswer({ path, search: { status: 'done', results: resultsFrom(body) } });
        },
        () => {
          if (!controller.signal.aborted) setAnswer({ path, search: { status: 'error', results: [] } });
        },
      );
    }, delayMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [path, client, delayMs]);

  if (path === null) return IDLE;
  return answer?.path === path ? answer.search : LOADING;
}
