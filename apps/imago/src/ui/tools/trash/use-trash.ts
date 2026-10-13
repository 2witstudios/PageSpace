'use client';

// What the trash view reads and writes: a drive's trashed tree, the titles
// that name where a page was, and a restore or a permanent delete. Each write
// takes the page (and what was inside it) out of the tree at once, then asks
// the server again, so the row is gone whether or not the answer is stale.

import { useCallback, useMemo } from 'react';
import useSWR from 'swr';
import { useApiClient } from '@/api/swr-provider';
import type { TrashPage } from './trash-model';
import { withoutPage } from './trash-model';
import { deleteTrashedPage, fetchDrivePageTitles, fetchTrash, restorePage } from './trash-api';

export const useTrash = (driveId: string) => {
  const client = useApiClient();
  const trash = useSWR(['imago:trash', driveId] as const, ([, id]) => fetchTrash(client, id));
  const drivePages = useSWR(['imago:trash-titles', driveId] as const, ([, id]) => fetchDrivePageTitles(client, id));
  const { mutate } = trash;

  const retry = useCallback(() => void mutate(), [mutate]);

  const restore = useCallback(
    async (pageId: string): Promise<void> => {
      await restorePage(client, pageId);
      await mutate((current: readonly TrashPage[] | undefined) => (current ? withoutPage(current, pageId) : current));
    },
    [client, mutate],
  );

  const remove = useCallback(
    async (pageId: string): Promise<void> => {
      await deleteTrashedPage(client, pageId);
      await mutate((current: readonly TrashPage[] | undefined) => (current ? withoutPage(current, pageId) : current));
    },
    [client, mutate],
  );

  // Titles of the live pages, plus the trashed ones, by id: a top-level row's
  // original parent is named from either.
  const titles = useMemo(() => {
    const byId = new Map<string, string>(drivePages.data ?? []);
    const visit = (nodes: readonly TrashPage[] | undefined): void => {
      for (const node of nodes ?? []) {
        byId.set(node.id, node.title);
        visit(node.children);
      }
    };
    visit(trash.data);
    return byId;
  }, [drivePages.data, trash.data]);

  return {
    tree: trash.data,
    error: trash.error as unknown,
    isLoading: trash.isLoading,
    titles,
    retry,
    restore,
    remove,
  };
};
