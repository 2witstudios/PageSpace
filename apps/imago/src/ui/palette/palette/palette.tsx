'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef } from 'react';
import { useApiClient } from '@/api/swr-provider';
import { chatPlugin } from '../../chat/chat-plugin';
import { fileIcon } from '../../files/tree-view/tree-view';
import type { DriveSummary } from '../../frame/drives/drives';
import { railDrive } from '../../frame/rail/rail-items';
import type { Stage } from '../../frame/stage/stage';
import type { UiState } from '../../store/state';
import { getUiState, useUiState } from '../../store/store';
import { dispatch } from '../../store/transactions';
import { palettePlugin } from '../palette-plugin';
import { destinationFor } from '../palette-route/palette-route';
import { searchPath, type PaletteResult } from '../palette-search/palette-search';
import { isApplePlatform, isPaletteShortcut } from '../palette-shortcut/palette-shortcut';
import { usePaletteSearch } from '../use-palette-search/use-palette-search';
import { renderPalette, type PaletteRow } from './palette.render';

export type CommandPaletteProps = {
  readonly stage: Stage;
  /** The viewer's Home drive: what the palette searches on a stage with no drive. */
  readonly homeDriveId: string | null;
  /** The viewer's drives, for the names beside results from every drive; null until listed. */
  readonly drives: readonly DriveSummary[] | null;
  /** The pause before searching; tests shorten it. */
  readonly delayMs?: number;
};

const { openPalette, closePalette, setPaletteQuery, togglePaletteAllDrives, movePaletteActive, setPaletteActive } =
  palettePlugin.transactions;

const selectOpen = (state: UiState) => state.resources.paletteOpen;
const selectQuery = (state: UiState) => state.resources.paletteQuery;
const selectAllDrives = (state: UiState) => state.resources.paletteAllDrives;
const selectActive = (state: UiState) => state.resources.paletteActive;

const rowFor = (result: PaletteResult, names: ReadonlyMap<string, string> | null): PaletteRow => ({
  id: result.id,
  title: result.title,
  icon: fileIcon(result.pageType),
  driveName: names === null ? null : (names.get(result.driveId) ?? null),
});

/**
 * The ⌘K command palette, mounted once by the shell. ⌘K (Ctrl-K off Apple)
 * opens it from anywhere and closes it again; closing gives focus back to
 * whatever had it. It searches the drive the rail is in, or with "Include
 * all workspaces" every drive, through apps/web's permission-filtered
 * search, and lists only what that search answers. Picking a result goes to
 * its imago route; an agent opens its drive's chat talking to it.
 */
export function CommandPalette({ stage, homeDriveId, drives, delayMs }: CommandPaletteProps) {
  const router = useRouter();
  const client = useApiClient();
  const open = useUiState(selectOpen);
  const query = useUiState(selectQuery);
  const allDrives = useUiState(selectAllDrives);
  const active = useUiState(selectActive);
  const idPrefix = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const driveId = railDrive(stage, homeDriveId);
  const path = open ? searchPath({ query, driveId, allDrives }) : null;
  const search = usePaletteSearch(path, delayMs === undefined ? { client } : { client, delayMs });
  const names = allDrives ? new Map((drives ?? []).map((drive) => [drive.id, drive.name])) : null;
  const rows = search.results.map((result) => rowFor(result, names));
  const scope = allDrives ? 'all workspaces' : (drives?.find((drive) => drive.id === driveId)?.name ?? 'this drive');

  const close = useCallback(() => {
    dispatch(closePalette, undefined);
    const previous = returnFocus.current;
    returnFocus.current = null;
    if (previous?.isConnected) previous.focus();
  }, []);

  useEffect(() => {
    const apple = isApplePlatform(window.navigator);
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event, apple)) return;
      event.preventDefault();
      if (getUiState().resources.paletteOpen) {
        close();
        return;
      }
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dispatch(openPalette, undefined);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const pick = (index: number) => {
    const result = search.results[index];
    if (result === undefined) return;
    const { href, agent } = destinationFor(result);
    if (agent !== null) dispatch(chatPlugin.transactions.selectAgent, agent);
    close();
    router.push(href);
  };

  return renderPalette({
    open,
    query,
    allDrives,
    scope,
    status: search.status,
    rows,
    active,
    idPrefix,
    inputRef,
    typeQuery: (next) => dispatch(setPaletteQuery, next),
    toggleAllDrives: () => dispatch(togglePaletteAllDrives, undefined),
    move: (by) => dispatch(movePaletteActive, { by, count: rows.length }),
    pick,
    hover: (index) => dispatch(setPaletteActive, index),
    close,
  });
}
