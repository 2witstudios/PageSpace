'use client';

// What every Files surface reads: a drive's page tree as file nodes, kept
// live, with the viewer's expanded pages and lazily loaded children.
//
// The tree comes from GET /api/drives/[driveId]/pages through the imago
// client and SWR. Expanding a page loads its children from GET
// /api/pages/[pageId]/children, which a folder browser can also ask for
// directly. Page events for the drive arrive in its realtime room and
// revalidate the tree, coalesced so a burst refetches once. Expansion lives in
// the shell store, never in the tree data, so a revalidation keeps it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { useApiClient } from '@/api/swr-provider';
import { ApiError } from '@/api/errors';
import { useDriveRoom, useSocketEvent } from '@/realtime/realtime-provider';
import { getUiState, useUiState } from '../../store/store';
import { dispatch, transactions } from '../../store/transactions';
import { fileNodesFrom } from '../file-model/from-api';
import type { FileNode, PageResponse, PageTreeResponse } from '../file-model/file-node';
import { composeTree, type LoadedChildren, type TreeAnswer } from '../file-tree/file-tree';

/**
 * The page events realtime sends a drive's room that change its tree
 * (apps/web broadcastPageEvent: `page:${operation}`). page:content-updated is
 * left out: an edit to a page's body changes nothing in the tree, and it
 * fires on every save while someone types.
 */
export const TREE_EVENTS = [
  'page:created',
  'page:updated',
  'page:moved',
  'page:trashed',
  'page:restored',
  'page:deleted',
] as const;

/** How long a tree event waits for the rest of its burst before the tree refetches. */
export const REVALIDATE_DELAY_MS = 100;

export type LoadResult = { readonly ok: true } | { readonly ok: false; readonly refusal: string };

export type FileTree = {
  /** The drive's pages as file nodes; undefined until the first answer. */
  readonly nodes: readonly FileNode[] | undefined;
  readonly error: unknown;
  readonly isLoading: boolean;
  readonly expandedIds: readonly string[];
  /** Pages whose children are on their way. */
  readonly loadingIds: readonly string[];
  /** Expands or collapses a page; expanding loads its children. */
  readonly toggle: (pageId: string) => void;
  readonly loadChildren: (pageId: string) => Promise<LoadResult>;
  /** Void action: asks the server for the tree again after a failure. */
  readonly retry: () => void;
};

const OFFLINE = 'Could not reach PageSpace';
const NO_DRIVE = 'No drive is open';

// One clock for every tree and children request, read when each is asked for.
let clock = 0;
const tick = (): number => {
  clock += 1;
  return clock;
};

const drivePagesPath = (driveId: string) => `/api/drives/${encodeURIComponent(driveId)}/pages`;
const childrenPath = (pageId: string) => `/api/pages/${encodeURIComponent(pageId)}/children`;

const isDriveEvent = (payload: unknown, driveId: string | null): boolean =>
  driveId !== null &&
  typeof payload === 'object' &&
  payload !== null &&
  (payload as { driveId?: unknown }).driveId === driveId;

type Loaded = { readonly driveId: string | null; readonly byParent: LoadedChildren };

/** A drive's page tree, live, with expansion and lazily loaded children. */
export const useFileTree = (driveId: string | null): FileTree => {
  const client = useApiClient();
  const { data, error, isLoading, mutate } = useSWR(
    driveId === null ? null : (['imago:file-tree', driveId] as const),
    async ([, id]): Promise<TreeAnswer> => {
      const at = tick();
      const pages = await client.apiFetch<readonly PageTreeResponse[]>(drivePagesPath(id));
      return { pages, at };
    },
  );

  const expandedIds = useUiState((state) => state.resources.expandedFileIds);

  const [loaded, setLoaded] = useState<Loaded>({ driveId, byParent: {} });
  const [loadingIds, setLoadingIds] = useState<readonly string[]>([]);
  const currentDrive = useRef(driveId);
  currentDrive.current = driveId;
  const inFlight = useRef(new Map<string, Promise<LoadResult>>());

  const loadChildren = useCallback(
    (pageId: string): Promise<LoadResult> => {
      const drive = currentDrive.current;
      if (drive === null) return Promise.resolve({ ok: false, refusal: NO_DRIVE });
      const pending = inFlight.current.get(pageId);
      if (pending) return pending;

      setLoadingIds((ids) => [...ids, pageId]);
      const at = tick();
      const request = client
        .apiFetch<readonly PageResponse[]>(childrenPath(pageId))
        .then(
          (children): LoadResult => {
            setLoaded((prev) => {
              if (currentDrive.current !== drive) return prev;
              const byParent = prev.driveId === drive ? prev.byParent : {};
              return { driveId: drive, byParent: { ...byParent, [pageId]: { children, at } } };
            });
            return { ok: true };
          },
          (failure: unknown): LoadResult => ({
            ok: false,
            refusal: failure instanceof ApiError ? failure.message : OFFLINE,
          }),
        )
        .finally(() => {
          inFlight.current.delete(pageId);
          setLoadingIds((ids) => ids.filter((id) => id !== pageId));
        });
      inFlight.current.set(pageId, request);
      return request;
    },
    [client],
  );

  const toggle = useCallback(
    (pageId: string) => {
      const expanding = !getUiState().resources.expandedFileIds.includes(pageId);
      dispatch(transactions.toggleFileFolder, pageId);
      if (expanding) void loadChildren(pageId);
    },
    [loadChildren],
  );

  // Live: join the drive's room and refetch the tree once per burst of events.
  useDriveRoom(driveId);
  const pendingRevalidation = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTreeEvent = (payload: unknown) => {
    if (!isDriveEvent(payload, driveId) || pendingRevalidation.current !== null) return;
    pendingRevalidation.current = setTimeout(() => {
      pendingRevalidation.current = null;
      void mutate();
    }, REVALIDATE_DELAY_MS);
  };
  useSocketEvent('page:created', onTreeEvent);
  useSocketEvent('page:updated', onTreeEvent);
  useSocketEvent('page:moved', onTreeEvent);
  useSocketEvent('page:trashed', onTreeEvent);
  useSocketEvent('page:restored', onTreeEvent);
  useSocketEvent('page:deleted', onTreeEvent);
  useEffect(
    () => () => {
      if (pendingRevalidation.current !== null) clearTimeout(pendingRevalidation.current);
      pendingRevalidation.current = null;
    },
    [driveId],
  );

  const byParent = loaded.driveId === driveId ? loaded.byParent : undefined;
  const nodes = useMemo(
    () => (data === undefined ? undefined : fileNodesFrom(composeTree(data, byParent ?? {}))),
    [data, byParent],
  );

  const retry = useCallback(() => void mutate(), [mutate]);

  return { nodes, error: error as unknown, isLoading, expandedIds, loadingIds, toggle, loadChildren, retry };
};
