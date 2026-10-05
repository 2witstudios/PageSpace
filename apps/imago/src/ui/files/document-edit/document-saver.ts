// Saving a document as it is edited, the way classic's DocumentView does:
// one PATCH per pause in typing (not per key), at once when the viewer
// leaves, renames it or asks, and always against the revision the editor last
// knew, so the server refuses a save over someone else's (409).
//
// The viewer's text is never dropped here. A save that fails keeps the text
// pending and says why; a conflict keeps it and stops saving until the viewer
// keeps theirs or takes the stored copy; a 403 keeps it and turns read-only.
// One save is out at a time, so an older save never lands after a newer one.

import { ApiError } from '@/api/errors';

/** What one PATCH /api/pages/[pageId] changes. */
export type DocumentPatch = { readonly content?: string; readonly title?: string };

export type TimerId = ReturnType<typeof setTimeout> | number;

export type SaveStatus =
  | { readonly kind: 'saved' }
  | { readonly kind: 'unsaved' }
  | { readonly kind: 'saving' }
  /** Someone else saved first; the viewer's text is kept and not sent. */
  | { readonly kind: 'conflict' }
  /** The server refused the viewer's edit rights; the text is kept and not sent. */
  | { readonly kind: 'read-only' }
  | { readonly kind: 'failed'; readonly message: string };

export type SaverState = {
  readonly status: SaveStatus;
  /** Whether the editor holds text the server does not: nothing may be loaded over it. */
  readonly editing: boolean;
};

/** How a flush ended. */
export type FlushOutcome = 'saved' | 'conflict' | 'read-only' | 'failed';

export type DocumentSaverOptions = {
  /** The revision of the content the editor opened with. */
  readonly revision: number;
  /** Sends one PATCH; resolves with the page's new revision, rejects when it was not saved. */
  readonly send: (patch: DocumentPatch, expectedRevision: number) => Promise<{ readonly revision: number }>;
  /** Told each time the state changes. */
  readonly onState: (state: SaverState) => void;
  /** How long typing must pause before a save. */
  readonly delayMs?: number;
  readonly schedule?: (run: () => void, delayMs: number) => TimerId;
  readonly cancel?: (id: TimerId | undefined) => void;
};

export type DocumentSaver = {
  /** Records the document's latest content and saves it once typing pauses. */
  readonly edit: (content: string) => void;
  /** Renames the page now, with any content still waiting. */
  readonly rename: (title: string) => Promise<FlushOutcome>;
  /** Saves what is waiting now. */
  readonly flush: () => Promise<FlushOutcome>;
  /** Settles a conflict by saving the viewer's text over `revision`, the one now stored. */
  readonly keepMine: (revision: number) => Promise<FlushOutcome>;
  /** The editor now shows the stored copy at `revision`: what was waiting is dropped. */
  readonly adopt: (revision: number) => void;
  readonly isEditing: () => boolean;
  /** What the server does not have yet; null when it has everything. */
  readonly unsaved: () => DocumentPatch | null;
};

/** The pause before a document is saved (classic's saveWithDebounce). */
export const DOCUMENT_SAVE_DELAY_MS = 1000;

const UNREACHABLE = 'Could not reach PageSpace. Your text is kept here.';

const merge = (older: DocumentPatch | null, newer: DocumentPatch | null): DocumentPatch | null =>
  older === null ? newer : newer === null ? older : { ...older, ...newer };

export const createDocumentSaver = ({
  revision: opened,
  send,
  onState,
  delayMs = DOCUMENT_SAVE_DELAY_MS,
  schedule = (run, ms) => setTimeout(run, ms),
  cancel = (id) => clearTimeout(id),
}: DocumentSaverOptions): DocumentSaver => {
  let revision = opened;
  let pending: DocumentPatch | null = null;
  let timer: TimerId | undefined;
  let inFlight: Promise<FlushOutcome> | null = null;
  let status: SaveStatus = { kind: 'saved' };

  const isEditing = () =>
    pending !== null || inFlight !== null || status.kind === 'saving' || status.kind === 'conflict';

  const setStatus = (next: SaveStatus): void => {
    const same =
      next.kind === status.kind && (next.kind !== 'failed' || (status.kind === 'failed' && status.message === next.message));
    status = next;
    if (!same) onState({ status, editing: isEditing() });
  };

  /** A conflict or a refusal holds the text until the viewer decides. */
  const held = () => status.kind === 'conflict' || status.kind === 'read-only';

  const stopTimer = (): void => {
    cancel(timer);
    timer = undefined;
  };

  const sendNow = async (patch: DocumentPatch): Promise<FlushOutcome> => {
    setStatus({ kind: 'saving' });
    try {
      ({ revision } = await send(patch, revision));
      return 'saved';
    } catch (error) {
      // Whatever came in while this was out is newer than what was sent.
      pending = merge(patch, pending);
      if (error instanceof ApiError && error.status === 409) return 'conflict';
      if (error instanceof ApiError && error.status === 403) return 'read-only';
      setStatus({ kind: 'failed', message: error instanceof ApiError ? error.message : UNREACHABLE });
      return 'failed';
    }
  };

  const flush = async (): Promise<FlushOutcome> => {
    stopTimer();
    // Wait out the save already out; whoever wakes first sends the latest.
    while (inFlight !== null) await inFlight;
    if (status.kind === 'conflict' || status.kind === 'read-only') return status.kind;
    if (pending === null) return status.kind === 'failed' ? 'failed' : 'saved';
    const patch = pending;
    pending = null;
    const saving = sendNow(patch);
    inFlight = saving;
    const outcome = await saving;
    inFlight = null;
    if (outcome === 'conflict' || outcome === 'read-only') setStatus({ kind: outcome });
    else if (outcome === 'saved') setStatus(pending === null ? { kind: 'saved' } : { kind: 'unsaved' });
    return outcome;
  };

  return {
    edit: (content) => {
      pending = merge(pending, { content });
      if (held()) return;
      if (status.kind !== 'saving') setStatus({ kind: 'unsaved' });
      stopTimer();
      timer = schedule(() => {
        void flush();
      }, delayMs);
    },
    rename: (title) => {
      pending = merge(pending, { title });
      if (!held() && status.kind !== 'saving') setStatus({ kind: 'unsaved' });
      return flush();
    },
    flush,
    keepMine: (stored) => {
      if (status.kind !== 'conflict') return flush();
      revision = stored;
      status = { kind: 'unsaved' };
      return flush();
    },
    adopt: (stored) => {
      stopTimer();
      revision = stored;
      pending = null;
      setStatus({ kind: 'saved' });
    },
    isEditing,
    unsaved: () => pending,
  };
};
