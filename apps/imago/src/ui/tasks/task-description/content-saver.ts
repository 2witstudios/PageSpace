// Saving a description as it is typed: one PATCH per pause, not per key, and
// at once when the field is left or closed. One save is out at a time: a
// flush while one is in flight waits for its answer, then sends only the
// latest text, so an older save can never land after a newer one.

import { ApiError } from '@/api/errors';

export type SaveResult = { readonly ok: true } | { readonly ok: false; readonly refusal: string };

export type TimerId = ReturnType<typeof setTimeout> | number;

export type ContentSaverOptions = {
  /** Sends one version of the content; rejects when it was not saved. */
  readonly send: (html: string) => Promise<unknown>;
  /** Told how every save ended. */
  readonly onResult: (result: SaveResult) => void;
  /** How long typing must pause before a save. */
  readonly delayMs?: number;
  readonly schedule?: (run: () => void, delayMs: number) => TimerId;
  readonly cancel?: (id: TimerId | undefined) => void;
};

export type ContentSaver = {
  /** Records the latest content and saves it once typing pauses. */
  readonly save: (html: string) => void;
  /** Saves the latest unsaved content now; nothing when there is none. */
  readonly flush: () => Promise<void>;
};

/** The pause before a description is saved. */
export const DESCRIPTION_SAVE_DELAY_MS = 600;

const UNREACHABLE = 'Could not save the description';

export const createContentSaver = ({
  send,
  onResult,
  delayMs = DESCRIPTION_SAVE_DELAY_MS,
  schedule = (run, ms) => setTimeout(run, ms),
  cancel = (id) => clearTimeout(id),
}: ContentSaverOptions): ContentSaver => {
  let pending: string | null = null;
  let timer: TimerId | undefined;
  let inFlight: Promise<void> | null = null;

  const send1 = async (html: string): Promise<void> => {
    try {
      await send(html);
      onResult({ ok: true });
    } catch (error) {
      onResult({ ok: false, refusal: error instanceof ApiError ? error.message : UNREACHABLE });
    }
  };

  const flush = async (): Promise<void> => {
    cancel(timer);
    timer = undefined;
    // Wait out the save already out; whoever wakes first sends the latest text.
    while (inFlight !== null) await inFlight;
    if (pending === null) return;
    const html = pending;
    pending = null;
    const saving = send1(html);
    inFlight = saving;
    await saving;
    if (inFlight === saving) inFlight = null;
  };

  return {
    save: (html) => {
      pending = html;
      cancel(timer);
      timer = schedule(() => {
        void flush();
      }, delayMs);
    },
    flush,
  };
};
