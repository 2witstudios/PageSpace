/**
 * Dev-preview pane store — WHICH holder's preview is open beside the agents
 * console, and the one signal the frame sends back.
 *
 * Client-only, deliberately NOT a workspace-grid pane target: the grid's node
 * model is server-persisted and shared with agents (`PaneTargetKind`), while
 * the preview is a per-viewer window onto a process that already lives
 * server-side as a `dev_preview_services` row. One preview pane at a time;
 * opening another replaces it (the sprite has one 8080, so a holder has one
 * preview — two panes would be two views of the same relay at best).
 *
 * `reloadNonce` is bumped when the preview origin posts `reauth-required`
 * (its short-lived cookie expired inside the frame): the pane re-points the
 * iframe at the app-origin `/preview/open` route, which re-runs the
 * handshake same-origin. Stores are pure — every fetch and every DOM
 * listener lives in the component.
 */

import { create } from 'zustand';
import type { DevPreviewHolderRef } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';

export interface OpenDevPreview {
  holder: DevPreviewHolderRef;
  /** Where the status is read from — the reader's own route (session or env). */
  statusPath: string;
  /** Where stop/resume are posted — `${statusPath}/actions`. */
  actionsPath: string;
  /** The app-origin `/preview/open` route the frame loads (and the new-tab link targets). */
  openPath: string;
  /** What to call it in the chrome — the session or environment name. */
  title: string;
  /** Whether this viewer may stop/resume it (the reader's own write gate). */
  canManage: boolean;
}

export interface DevPreviewPaneState {
  open: OpenDevPreview | null;
  reloadNonce: number;
  openPreview: (input: OpenDevPreview) => void;
  closePreview: () => void;
  /** Re-run the grant handshake in the frame (the preview origin asked for it, or the user hit Reload). */
  reload: () => void;
}

export const useDevPreviewPaneStore = create<DevPreviewPaneState>((set) => ({
  open: null,
  reloadNonce: 0,
  openPreview: (input) => set({ open: input, reloadNonce: 0 }),
  closePreview: () => set({ open: null }),
  reload: () => set((state) => ({ reloadNonce: state.reloadNonce + 1 })),
}));
