'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { mergeDrafts, shouldPersist } from '@/lib/draft/draft';
import {
  readLocal,
  writeLocal,
  removeLocal,
  fetchDraft,
  saveDraft,
  deleteDraft,
} from '@/lib/draft/draft.io';

const DEBOUNCE_MS = 400;

export const useDraft = (contextKey: string) => {
  const [value, setValue] = useState<string>(() =>
    contextKey ? readLocal(contextKey) : '',
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // On mount (or key change): fetch from server for cross-device restore.
  // localStorage value wins if already present; server fills the gap otherwise.
  // Capture the key at effect time to guard against stale closures if the
  // contextKey changes before the async fetch resolves.
  useEffect(() => {
    if (!contextKey) return;
    const activeKey = contextKey;
    setValue(readLocal(activeKey));
    fetchDraft(activeKey).then((server) => {
      if (server && activeKey === contextKey)
        setValue((local: string) => mergeDrafts(local, server));
    });
  }, [contextKey]);

  const setDraft = useCallback(
    (v: string) => {
      if (!contextKey) return;
      setValue(v);
      writeLocal(contextKey, v);
      clearTimeout(debounceRef.current);
      if (shouldPersist(v)) {
        debounceRef.current = setTimeout(() => saveDraft(contextKey, v), DEBOUNCE_MS);
      } else {
        deleteDraft(contextKey);
      }
    },
    [contextKey],
  );

  const clearDraft = useCallback(() => {
    if (!contextKey) return;
    clearTimeout(debounceRef.current);
    setValue('');
    removeLocal(contextKey);
    deleteDraft(contextKey);
  }, [contextKey]);

  return { draft: value, setDraft, clearDraft };
};
