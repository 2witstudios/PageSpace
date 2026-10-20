'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { mergeDrafts, shouldPersist } from '@/retained/lib/draft/draft';
import {
  readLocal,
  writeLocal,
  removeLocal,
  fetchDraft,
  saveDraft,
  deleteDraft,
} from '@/retained/lib/draft/draft.io';

const DEBOUNCE_MS = 400;

export const useDraft = (contextKey: string) => {
  const [value, setValue] = useState<string>(() =>
    contextKey ? readLocal(contextKey) : '',
  );
  // The latest draft, for updaters and the server merge. Written only in effects and handlers.
  const valueRef = useRef(value);
  // Set once the user types or clears under the current key: a server read that lands after
  // that is stale and must not put sent text back.
  const editedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // On mount (or key change): fetch from server for cross-device restore.
  // localStorage value wins if already present; server fills the gap otherwise.
  // A read for a key this hook has moved off, or one that lands after an edit, is dropped.
  useEffect(() => {
    editedRef.current = false;
    if (!contextKey) return;
    const local = readLocal(contextKey);
    valueRef.current = local;
    setValue(local);
    let current = true;
    fetchDraft(contextKey).then((server) => {
      if (!server || !current || editedRef.current) return;
      const merged = mergeDrafts(valueRef.current, server);
      valueRef.current = merged;
      setValue(merged);
    });
    return () => {
      current = false;
    };
  }, [contextKey]);

  const setDraft = useCallback(
    (next: string | ((current: string) => string)) => {
      if (!contextKey) return;
      const v = typeof next === 'function' ? next(valueRef.current) : next;
      editedRef.current = true;
      valueRef.current = v;
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
    editedRef.current = true;
    valueRef.current = '';
    setValue('');
    removeLocal(contextKey);
    deleteDraft(contextKey);
  }, [contextKey]);

  return { draft: value, setDraft, clearDraft };
};
