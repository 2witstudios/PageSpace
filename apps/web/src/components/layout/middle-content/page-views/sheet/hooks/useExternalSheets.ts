import { useEffect, useRef, useState } from 'react';
import {
  parseSheetContent,
  sanitizeSheetData,
  type SheetExternalReferenceToken,
} from '@pagespace/lib/sheets/sheet';
import { PageType } from '@pagespace/lib/utils/enums';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import type { ExternalSheetState } from '../core/references';

/**
 * Shell hook that loads the sheets referenced by `[[…]]` tokens. It prunes cache
 * entries whose reference disappeared, resolves each new reference to a target
 * page, and fetches it (deduping in-flight requests via a ref). All resolution
 * ranking lives in the pure references core; this hook owns only the effects.
 */
export const useExternalSheets = (
  externalReferences: SheetExternalReferenceToken[],
  resolveReference: (reference: SheetExternalReferenceToken) => { pageId: string; title: string } | null,
): Record<string, ExternalSheetState> => {
  const [externalSheets, setExternalSheets] = useState<Record<string, ExternalSheetState>>({});
  const externalFetchesRef = useRef<Set<string>>(new Set());

  // Prune entries whose reference no longer exists.
  useEffect(() => {
    setExternalSheets((prev) => {
      const next: Record<string, ExternalSheetState> = {};
      let changed = false;

      for (const reference of externalReferences) {
        if (prev[reference.raw]) {
          next[reference.raw] = prev[reference.raw];
        } else {
          changed = true;
        }
      }

      if (!changed && Object.keys(next).length === Object.keys(prev).length) {
        return prev;
      }

      return next;
    });
  }, [externalReferences]);

  // Resolve + fetch each reference that is not already loading/ready.
  useEffect(() => {
    externalReferences.forEach((reference) => {
      const existing = externalSheets[reference.raw];
      if (existing && (existing.status === 'loading' || existing.status === 'ready')) {
        return;
      }

      const target = resolveReference(reference);
      if (!target) {
        setExternalSheets((prev) => ({
          ...prev,
          [reference.raw]: {
            status: 'error',
            label: reference.label,
            identifier: reference.identifier,
            mentionType: reference.mentionType,
            error: `Referenced page "${reference.label}" could not be found`,
          },
        }));
        return;
      }

      if (externalFetchesRef.current.has(reference.raw)) {
        return;
      }

      externalFetchesRef.current.add(reference.raw);

      setExternalSheets((prev) => ({
        ...prev,
        [reference.raw]: {
          status: 'loading',
          label: reference.label,
          identifier: reference.identifier,
          mentionType: reference.mentionType,
          pageId: target.pageId,
          title: target.title,
        },
      }));

      fetchWithAuth(`/api/pages/${target.pageId}`)
        .then(async (response) => {
          if (!response.ok) {
            if (response.status === 403) {
              throw new Error(`You do not have access to "${target.title}"`);
            }
            throw new Error('Failed to load referenced page');
          }

          const contentType = response.headers.get('content-type');
          if (!contentType || !contentType.includes('application/json')) {
            const fallbackMessage = await response
              .text()
              .then((text) => text.trim())
              .catch(() => '');
            throw new Error(
              fallbackMessage || 'Received unexpected response when loading referenced page'
            );
          }

          let parsedResponse: unknown;
          try {
            parsedResponse = await response.json();
          } catch {
            throw new Error('Failed to parse referenced page response');
          }

          if (!parsedResponse || typeof parsedResponse !== 'object') {
            throw new Error('Referenced page response was not valid JSON');
          }

          const data = parsedResponse as { type?: PageType; content?: unknown };

          if (data.type && data.type !== PageType.SHEET) {
            throw new Error(`Referenced page "${target.title}" is not a sheet`);
          }

          if (!('content' in data)) {
            throw new Error('Referenced page response did not include any content');
          }

          const parsed = sanitizeSheetData(parseSheetContent(data.content));
          setExternalSheets((prev) => ({
            ...prev,
            [reference.raw]: {
              status: 'ready',
              label: reference.label,
              identifier: reference.identifier,
              mentionType: reference.mentionType,
              pageId: target.pageId,
              title: target.title,
              sheet: parsed,
            },
          }));
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : 'Failed to load referenced page';
          setExternalSheets((prev) => ({
            ...prev,
            [reference.raw]: {
              status: 'error',
              label: reference.label,
              identifier: reference.identifier,
              mentionType: reference.mentionType,
              pageId: target.pageId,
              title: target.title,
              error: message,
            },
          }));
        })
        .finally(() => {
          externalFetchesRef.current.delete(reference.raw);
        });
    });
  }, [externalReferences, externalSheets, resolveReference]);

  return externalSheets;
};
