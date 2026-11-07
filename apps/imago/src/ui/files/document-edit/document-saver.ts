// Saving a document as it is edited, the way classic's DocumentView does:
// one PATCH per pause in typing (not per key), at once when the viewer
// leaves, renames it or asks, and always against the content revision the editor
// last knew, so the server refuses a save over a change to the text (409). A
// rename or a move does not move that revision, so it can never refuse a save.
//
// The viewer's text is never dropped here. A save that fails keeps the text
// pending and says why; a conflict keeps it and stops saving until the viewer
// keeps theirs or takes the stored copy; a 403 keeps it and turns read-only.
// One save is out at a time, so an older save never lands after a newer one.

import { isOwnUnconfirmedSave } from '@pagespace/lib/documents/page-save';
import { ApiError, CSRF_REJECTION_CODES } from '@/api/errors';

/** What one PATCH /api/pages/[pageId] changes. */
export type DocumentPatch = { readonly content?: string; readonly title?: string };

export type TimerId = ReturnType<typeof setTimeout> | number;

export type SaveStatus =
  | { readonly kind: 'saved' }
  | { readonly kind: 'unsaved' }
  | { readonly kind: 'saving' }
  /** The text changed elsewhere first; the viewer's text is kept and not sent. */
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
  /** The content revision the editor opened with. */
  readonly contentRevision: number;
  readonly contentMode?: 'html' | 'markdown';
  /** Sends one PATCH; resolves with the page's new content revision, rejects when it was not saved. */
  readonly send: (patch: DocumentPatch, expectedContentRevision: number, contentMode: 'html' | 'markdown') => Promise<{ readonly contentRevision: number }>;
  /** Told each time the state changes. */
  readonly onState: (state: SaverState) => void;
  /**
   * Reads what the server holds now. Asked only after a 409 while an earlier
   * save is unanswered, to tell whether that save is what refused this one.
   */
  readonly readStored?: () => Promise<{ readonly contentRevision: number; readonly content: string; readonly contentMode?: 'html' | 'markdown' }>;
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
  /** Holds text kept from an earlier visit (made at `contentRevision`) and saves it once typing pauses. */
  readonly restore: (patch: DocumentPatch, contentRevision: number, contentMode?: 'html' | 'markdown') => void;
  /** Settles a conflict by saving the viewer's text over `contentRevision`, the one now stored. */
  readonly keepMine: (contentRevision: number) => Promise<FlushOutcome>;
  /** The editor now shows the stored copy at `contentRevision`: what was waiting is dropped. */
  readonly adopt: (contentRevision: number, contentMode?: 'html' | 'markdown') => void;
  readonly contentMode: () => 'html' | 'markdown';
  readonly isEditing: () => boolean;
  /** The content revision the next save is made against. */
  readonly contentRevision: () => number;
  /** What the server does not have yet; null when it has everything. */
  readonly unsaved: () => DocumentPatch | null;
};

/** The pause before a document is saved (classic's saveWithDebounce). */
export const DOCUMENT_SAVE_DELAY_MS = 1000;

const UNREACHABLE = 'Could not reach PageSpace. Your text is kept here.';

const SESSION = 'Your session could not be confirmed. Your text is kept here: try again, or reload the page.';

/** A 403 for the CSRF token (still refused after the client's own retry), not for the viewer's rights. */
const isCsrfRefusal = (error: ApiError): boolean =>
  error.status === 403 && error.code !== null && CSRF_REJECTION_CODES.has(error.code);

const merge = (older: DocumentPatch | null, newer: DocumentPatch | null): DocumentPatch | null =>
  older === null ? newer : newer === null ? older : { ...older, ...newer };

/**
 * Whether a failure leaves open that the write landed anyway: no answer at all,
 * or the server failing, possibly after the write. A 4xx is a definite refusal.
 */
const mayHaveBeenStored = (error: unknown): boolean => !(error instanceof ApiError) || error.status >= 500;

export const createDocumentSaver = ({
  contentRevision: opened,
  contentMode: openedMode = 'html',
  send,
  onState,
  readStored,
  delayMs = DOCUMENT_SAVE_DELAY_MS,
  schedule = (run, ms) => setTimeout(run, ms),
  cancel = (id) => clearTimeout(id),
}: DocumentSaverOptions): DocumentSaver => {
  let contentRevision = opened;
  let contentMode = openedMode;
  /** Text sent in a save that never got an answer, and so may be what the server holds. */
  let unconfirmed: string | undefined;
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

  /**
   * Whether this client's own unanswered save is what the server refused this
   * one over. If so the saver moves on to where that save left the text, once:
   * `unconfirmed` is cleared, so a further refusal is a real one.
   */
  const claimOwnSave = async (): Promise<boolean> => {
    if (unconfirmed === undefined || readStored === undefined) return false;
    try {
      const stored = await readStored();
      if (!isOwnUnconfirmedSave(stored.content, unconfirmed, stored.contentMode ?? 'html', contentMode)) return false;
      contentRevision = stored.contentRevision;
      unconfirmed = undefined;
      return true;
    } catch {
      // Could not tell, so it stays what it looks like: a conflict to settle.
      return false;
    }
  };

  const sendNow = async (patch: DocumentPatch): Promise<FlushOutcome> => {
    setStatus({ kind: 'saving' });
    try {
      const saved = await send(patch, contentRevision, contentMode);
      // A title-only response can contain a body the editor has never shown.
      // Only a content save establishes a new baseline for its pending text.
      if (patch.content !== undefined) {
        contentRevision = saved.contentRevision;
        unconfirmed = undefined;
      }
      return 'saved';
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && (await claimOwnSave())) return sendNow(patch);
      if (patch.content !== undefined && mayHaveBeenStored(error)) unconfirmed = patch.content;
      // Whatever came in while this was out is newer than what was sent.
      pending = merge(patch, pending);
      if (error instanceof ApiError && error.status === 409) return 'conflict';
      if (error instanceof ApiError && error.status === 403 && !isCsrfRefusal(error)) return 'read-only';
      const message = !(error instanceof ApiError) ? UNREACHABLE : isCsrfRefusal(error) ? SESSION : error.message;
      setStatus({ kind: 'failed', message });
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

  /** Saves what is waiting once typing pauses. */
  const later = (): void => {
    stopTimer();
    timer = schedule(() => {
      void flush();
    }, delayMs);
  };

  return {
    edit: (content) => {
      pending = merge(pending, { content });
      if (held()) return;
      if (status.kind !== 'saving') setStatus({ kind: 'unsaved' });
      later();
    },
    restore: (patch, kept, mode) => {
      if (mode !== undefined) contentMode = mode;
      contentRevision = kept;
      pending = merge(patch, pending);
      setStatus({ kind: 'unsaved' });
      later();
    },
    rename: (title) => {
      pending = merge(pending, { title });
      if (!held() && status.kind !== 'saving') setStatus({ kind: 'unsaved' });
      return flush();
    },
    flush,
    keepMine: (stored) => {
      if (status.kind !== 'conflict') return flush();
      contentRevision = stored;
      status = { kind: 'unsaved' };
      return flush();
    },
    adopt: (stored, mode) => {
      if (mode !== undefined) contentMode = mode;
      stopTimer();
      contentRevision = stored;
      unconfirmed = undefined;
      pending = null;
      setStatus({ kind: 'saved' });
    },
    isEditing,
    contentRevision: () => contentRevision,
    contentMode: () => contentMode,
    unsaved: () => pending,
  };
};
