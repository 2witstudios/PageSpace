'use client';

import { useEffect } from 'react';
import { IMAGO_BASE_PATH } from '@/lib/auth/sign-in-url';
import { useUIStore } from '@/retained/stores/useUIStore';
import { dispatch, transactions } from '../../store/transactions';
import { stageFor, type Stage } from '../stage/stage';
import { createTabId, imagoPathOf, isNewTabClick, tabPathFor } from './tabs-model';

/**
 * ⌘/Ctrl-click and middle-click on a link to a page in this drive open it as a tab beside the
 * active one without leaving it, as classic's tab bar does, instead of a browser tab. Plain
 * clicks load into the active tab (useOpenTabs).
 */
export function useNewTabClicks(stage: Stage): void {
  const driveId = stage.driveId;
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || !isNewTabClick(event)) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || (anchor.target !== '' && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const path = imagoPathOf(anchor.href, window.location.origin, IMAGO_BASE_PATH);
      if (path === null) return;
      const target = stageFor(path);
      if (tabPathFor(target, path) === null || target.driveId !== driveId) return;
      event.preventDefault();
      dispatch(transactions.openBackgroundTab, { path, id: createTabId() });
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('auxclick', onClick, true);
    };
  }, [driveId]);
}

/**
 * New tab: the page created from the palette opens in a new tab. A palette dismissed without
 * creating anything withdraws the request at the viewer's next press, so a later plain click
 * still loads into the active tab.
 */
export const requestNewTab = (): void => {
  dispatch(transactions.setNewTabPending, true);
  useUIStore.getState().openQuickCreate(null);
  const unsubscribe = useUIStore.subscribe((state) => {
    if (state.quickCreateOpen) return;
    unsubscribe();
    const withdraw = () => {
      document.removeEventListener('pointerdown', withdraw, true);
      document.removeEventListener('keydown', withdraw, true);
      dispatch(transactions.setNewTabPending, false);
    };
    document.addEventListener('pointerdown', withdraw, true);
    document.addEventListener('keydown', withdraw, true);
  });
};
