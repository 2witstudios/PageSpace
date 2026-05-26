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
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // On mount (or key change): fetch from server for cross-device restore.
  // localStorage value wins if already present; server fills the gap otherwise.
  useEffect(() => {
    if (!contextKey) return;
    setValue(readLocal(contextKey));
    fetchDraft(contextKey).then((server) => {
      if (server) setValue((local: string) => mergeDrafts(local, server));
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
