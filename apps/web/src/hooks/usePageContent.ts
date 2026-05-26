import { useState, useEffect, useRef, useCallback } from 'react';
import { createId } from '@paralleldrive/cuid2';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';

export interface UsePageContentOptions {
  pageId: string | null;
  enabled?: boolean;
  debounceMs?: number;
  // When provided, seeds content without fetching. Use when the caller already
  // has the page content (e.g. from TreePage) and wants to avoid a redundant GET.
  initialContent?: string | null;
}

// isRichContentEmpty is used only for emptiness checks, not for rendering HTML.
// The regex strips tags to measure visible text length — no output is produced.
export const isRichContentEmpty = (html: string | null): boolean => {
  if (!html) return true;
  return html.replace(/<[^>]*>/g, '').trim().length === 0;
};

export const isDirty = (pending: string | null): boolean => pending !== null;

export const usePageContent = ({
  pageId,
  enabled = true,
  debounceMs = 1000,
  initialContent,
}: UsePageContentOptions) => {
  // If initialContent is provided, seed state from it and skip the first fetch.
  const seededRef = useRef(initialContent !== undefined);
  const [content, setContent] = useState<string | null>(
    initialContent !== undefined ? initialContent : null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const pendingContentRef = useRef<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sessionId] = useState(() => createId());

  useEffect(() => {
    if (!pageId || !enabled) return;

    // Skip the initial fetch when caller seeded content; fetch on subsequent
    // pageId changes as normal (seededRef flips to false after first skip).
    if (seededRef.current) {
      seededRef.current = false;
      return;
    }

    let cancelled = false;
    // Clear stale content from previous page before the new fetch resolves.
    setContent(null);
    setIsLoading(true);

    fetchWithAuth(`/api/pages/${pageId}`)
      .then(res => (res.ok ? res.json() : null))
      .then(page => {
        if (!cancelled) setContent(page?.content ?? null);
      })
      .catch(() => {
        if (!cancelled) setContent(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [pageId, enabled]);

  // Force-save pending content on unmount.
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      const pending = pendingContentRef.current;
      if (isDirty(pending) && pageId) {
        useEditingStore.getState().startEditing(sessionId, 'document', { pageId });
        fetchWithAuth(`/api/pages/${pageId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: pending }),
        })
          .catch(() => {})
          .finally(() => {
            useEditingStore.getState().endEditing(sessionId);
          });
      }
    };
  }, [pageId, sessionId]);

  const performSave = useCallback(
    async (contentToSave: string) => {
      if (!pageId) return;
      setIsSaving(true);
      useEditingStore.getState().startEditing(sessionId, 'document', { pageId });
      try {
        await fetchWithAuth(`/api/pages/${pageId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: contentToSave }),
        });
        // Only clear pending if no newer content arrived while this save was in-flight.
        if (pendingContentRef.current === contentToSave) {
          pendingContentRef.current = null;
        }
      } catch {
        // silent — next edit will retry
      } finally {
        setIsSaving(false);
        useEditingStore.getState().endEditing(sessionId);
      }
    },
    [pageId, sessionId]
  );

  const save = useCallback(
    (html: string) => {
      if (!pageId) return;
      pendingContentRef.current = html;
      setContent(html);

      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        const pending = pendingContentRef.current;
        if (pending !== null) performSave(pending).catch(() => {});
      }, debounceMs);
    },
    [pageId, debounceMs, performSave]
  );

  const forceSave = useCallback(async () => {
    if (!isDirty(pendingContentRef.current) || !pageId) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    const pending = pendingContentRef.current;
    if (pending !== null) await performSave(pending);
  }, [pageId, performSave]);

  return { content, isLoading, isSaving, save, forceSave };
};
