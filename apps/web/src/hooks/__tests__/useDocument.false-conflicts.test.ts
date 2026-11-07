/**
 * The ways a person editing alone was told someone else had saved.
 *
 * Each case below is a sequence that used to end in the conflict banner with
 * nobody else involved, and the last group pins the other side: a real change by
 * someone else must still stop and ask, with the local text untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDocumentManagerStore } from '@/stores/useDocumentManagerStore';
import { useDirtyStore } from '@/stores/useDirtyStore';

vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../useSocket', () => ({ useSocket: vi.fn(() => ({ id: 'socket-123' })) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { useDocument } from '../useDocument';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';

const answer = (body: Record<string, unknown>, status = 200) =>
  ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as Response;

const conflict = (currentContentRevision: number, expectedContentRevision: number) =>
  answer({ error: 'Conflict', currentContentRevision, expectedContentRevision }, 409);

/** A response the test releases by hand, so a save can be kept in flight. */
const held = () => {
  let release!: (response: Response) => void;
  let fail!: (reason: unknown) => void;
  const promise = new Promise<Response>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
};

const patchBodies = () =>
  vi
    .mocked(fetchWithAuth)
    .mock.calls.filter(([, init]) => init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

const stored = (pageId: string) => useDocumentManagerStore.getState().documents.get(pageId);
const hasConflict = (pageId: string) => useDocumentManagerStore.getState().conflicts.has(pageId);

/** Drains the microtasks a save needs to get from one step to the next. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const open = (pageId: string, content: string, contentRevision: number) => {
  useDocumentManagerStore.getState().upsertDocument(pageId, content, 'html', contentRevision);
};

const type = (result: { current: ReturnType<typeof useDocument> }, content: string) => {
  act(() => result.current.updateContent(content));
};

describe('useDocument false conflicts', () => {
  // A page of its own per case: a save held open must not bleed into the next.
  let pageId: string;
  let sequence = 0;

  beforeEach(() => {
    sequence += 1;
    pageId = `page-${sequence}`;
    useDocumentManagerStore.setState({
      documents: new Map(),
      activeDocumentId: null,
      savingDocuments: new Set(),
      conflicts: new Map(),
      resolvingConflicts: new Set(),
    });
    useDirtyStore.setState({ dirtyFlags: {} });
    vi.mocked(fetchWithAuth).mockReset();
  });

  describe('a rename, a move or a privacy change while the page is open', () => {
    it('saves against the content lock and never sends the row revision', async () => {
      // A rename took the row from revision 12 to 13; the content is untouched.
      vi.mocked(fetchWithAuth).mockResolvedValueOnce(
        answer({ content: 'loaded', contentMode: 'html', revision: 13, contentRevision: 7 })
      );
      vi.mocked(fetchWithAuth).mockResolvedValueOnce(answer({ revision: 14, contentRevision: 8 }));
      const { result } = renderHook(() => useDocument(pageId));

      await act(() => result.current.initializeAndActivate());
      type(result, 'typed after the rename');
      await act(async () => {
        await result.current.forceSave();
      });

      expect(patchBodies()).toEqual([
        expect.objectContaining({ content: 'typed after the rename', expectedContentRevision: 7 }),
      ]);
      expect(patchBodies()[0]).not.toHaveProperty('expectedRevision');
      expect(hasConflict(pageId)).toBe(false);
      expect(stored(pageId)?.contentRevision).toBe(8);
    });
  });

  describe('a second save while the first is still out', () => {
    it('blur during a save: sends them one after the other, the second against the new revision', async () => {
      open(pageId, 'start', 7);
      const first = held();
      vi.mocked(fetchWithAuth).mockReturnValueOnce(first.promise);
      vi.mocked(fetchWithAuth).mockResolvedValueOnce(answer({ contentRevision: 9 }));
      const { result } = renderHook(() => useDocument(pageId));

      type(result, 'first text');
      let firstSave!: Promise<unknown>;
      act(() => {
        firstSave = result.current.forceSave();
      });

      type(result, 'second text');
      let secondSave!: Promise<unknown>;
      act(() => {
        secondSave = result.current.forceSave();
      });
      await act(settle);
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);

      await act(async () => {
        first.release(answer({ contentRevision: 8 }));
        await Promise.all([firstSave, secondSave]);
      });

      expect(patchBodies().map(({ content, expectedContentRevision }) => ({ content, expectedContentRevision }))).toEqual([
        { content: 'first text', expectedContentRevision: 7 },
        { content: 'second text', expectedContentRevision: 8 },
      ]);
      expect(hasConflict(pageId)).toBe(false);
      expect(stored(pageId)?.contentRevision).toBe(9);
      expect(stored(pageId)?.isDirty).toBe(false);
    });

    it('Cmd+S during a save of the same text: sends it once', async () => {
      open(pageId, 'start', 7);
      const first = held();
      vi.mocked(fetchWithAuth).mockReturnValueOnce(first.promise);
      const { result } = renderHook(() => useDocument(pageId));

      type(result, 'same text');
      let firstSave!: Promise<unknown>;
      let secondSave!: Promise<unknown>;
      act(() => {
        firstSave = result.current.forceSave();
        secondSave = result.current.forceSave();
      });

      await act(async () => {
        first.release(answer({ contentRevision: 8 }));
        await Promise.all([firstSave, secondSave]);
      });

      expect(patchBodies()).toHaveLength(1);
      expect(hasConflict(pageId)).toBe(false);
    });

    it('two panes showing one page both saving on blur: sends it once', async () => {
      open(pageId, 'start', 7);
      const first = held();
      vi.mocked(fetchWithAuth).mockReturnValueOnce(first.promise);
      const centre = renderHook(() => useDocument(pageId));
      const pane = renderHook(() => useDocument(pageId));

      type(centre.result, 'same text');
      let centreSave!: Promise<unknown>;
      let paneSave!: Promise<unknown>;
      act(() => {
        centreSave = centre.result.current.forceSave();
        paneSave = pane.result.current.forceSave();
      });

      await act(async () => {
        first.release(answer({ contentRevision: 8 }));
        await Promise.all([centreSave, paneSave]);
      });

      expect(patchBodies()).toHaveLength(1);
      expect(hasConflict(pageId)).toBe(false);
    });
  });

  describe('a save that was stored but never answered', () => {
    it('recognises its own text behind the refusal and carries on', async () => {
      open(pageId, 'start', 7);
      vi.mocked(fetchWithAuth)
        // The first save commits; its answer is lost on the way back.
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        // So the next one is refused, by that save.
        .mockResolvedValueOnce(conflict(8, 7))
        .mockResolvedValueOnce(answer({ content: 'first text', contentRevision: 8 }))
        .mockResolvedValueOnce(answer({ contentRevision: 9 }));
      const { result } = renderHook(() => useDocument(pageId));

      type(result, 'first text');
      await act(async () => {
        await result.current.forceSave().catch(() => undefined);
      });
      expect(stored(pageId)?.unconfirmedContent).toBe('first text');

      type(result, 'more typing');
      await act(async () => {
        await result.current.forceSave();
      });

      expect(hasConflict(pageId)).toBe(false);
      expect(patchBodies().at(-1)).toMatchObject({ content: 'more typing', expectedContentRevision: 8 });
      expect(stored(pageId)?.contentRevision).toBe(9);
      expect(stored(pageId)?.unconfirmedContent).toBeUndefined();
    });

    it('treats a server failure the same way, since the write may have landed first', async () => {
      open(pageId, 'start', 7);
      vi.mocked(fetchWithAuth).mockResolvedValueOnce(answer({ error: 'Failed to update page' }, 500));
      const { result } = renderHook(() => useDocument(pageId));

      type(result, 'first text');
      await act(async () => {
        await result.current.forceSave().catch(() => undefined);
      });

      expect(stored(pageId)?.unconfirmedContent).toBe('first text');
    });

    it('does not suspect a save the server definitely refused', async () => {
      open(pageId, 'start', 7);
      vi.mocked(fetchWithAuth).mockResolvedValueOnce(answer({ error: 'Forbidden' }, 403));
      const { result } = renderHook(() => useDocument(pageId));

      type(result, 'first text');
      await act(async () => {
        await result.current.forceSave().catch(() => undefined);
      });

      expect(stored(pageId)?.unconfirmedContent).toBeUndefined();
    });

    it('asks after all when a retry is refused again, rather than looping', async () => {
      open(pageId, 'start', 7);
      vi.mocked(fetchWithAuth)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(conflict(8, 7))
        .mockResolvedValueOnce(answer({ content: 'first text', contentRevision: 8 }))
        // Someone else got in between the claim and the retry.
        .mockResolvedValueOnce(conflict(9, 8))
        .mockResolvedValueOnce(answer({ content: 'their text', contentRevision: 9 }));
      const { result } = renderHook(() => useDocument(pageId));

      type(result, 'first text');
      await act(async () => {
        await result.current.forceSave().catch(() => undefined);
      });
      type(result, 'more typing');
      await act(async () => {
        await result.current.forceSave();
      });

      expect(hasConflict(pageId)).toBe(true);
      expect(fetchWithAuth).toHaveBeenCalledTimes(5);
      expect(stored(pageId)?.content).toBe('more typing');
    });
  });

  it('does not merge a refresh over text typed while its request was out', () => {
    open(pageId, 'start', 7);
    const { result } = renderHook(() => useDocument(pageId));
    type(result, 'local typing');
    act(() => result.current.updateContentFromServer('remote', 8));
    expect(stored(pageId)).toMatchObject({ content: 'local typing', contentRevision: 7, isDirty: true });
  });

  it('does not claim an unanswered clear after an unseen mode conversion', async () => {
    open(pageId, 'start', 7);
    vi.mocked(fetchWithAuth)
      .mockRejectedValueOnce(new TypeError('lost response'))
      .mockResolvedValueOnce(conflict(9, 7))
      .mockResolvedValueOnce(answer({ content: '', contentMode: 'markdown', contentRevision: 9 }))
      .mockResolvedValueOnce(answer({ contentRevision: 10 }));
    const { result } = renderHook(() => useDocument(pageId));
    type(result, '');
    await act(async () => { await result.current.forceSave().catch(() => undefined); });
    type(result, '<p>HTML typing</p>');
    await act(async () => { await result.current.forceSave(); });
    expect(hasConflict(pageId)).toBe(true);
    expect(patchBodies()).toHaveLength(2);
    expect(stored(pageId)).toMatchObject({ content: '<p>HTML typing</p>', contentMode: 'html', contentRevision: 7, isDirty: true });
  });

  it('sends its content mode even when resending identical empty bytes', async () => {
    open(pageId, 'start', 7);
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(answer({ contentRevision: 8 }));
    const { result } = renderHook(() => useDocument(pageId));
    type(result, '');
    await act(async () => { await result.current.forceSave(); });
    expect(patchBodies()[0]).toMatchObject({ content: '', contentMode: 'html', expectedContentRevision: 7 });
  });

  it('adopts remote content and mode together, and leaves both alone for an older refresh', () => {
    open(pageId, 'start', 7);
    const { result } = renderHook(() => useDocument(pageId));
    act(() => result.current.updateContentFromServer('markdown body', 8, 'markdown'));
    expect(stored(pageId)).toMatchObject({ content: 'markdown body', contentMode: 'markdown', contentRevision: 8 });
    act(() => result.current.updateContentFromServer('old HTML', 7, 'html'));
    expect(stored(pageId)).toMatchObject({ content: 'markdown body', contentMode: 'markdown', contentRevision: 8 });
  });

  it('use theirs adopts the remote content mode as well as its bytes and lock', async () => {
    open(pageId, 'start', 7);
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce(conflict(8, 7))
      .mockResolvedValueOnce(answer({ content: 'remote markdown', contentMode: 'markdown', contentRevision: 8 }));
    const { result } = renderHook(() => useDocument(pageId));
    type(result, '<p>mine</p>');
    await act(async () => { await result.current.forceSave(); });
    await act(async () => { await result.current.resolveConflict('use-theirs'); });
    expect(stored(pageId)).toMatchObject({ content: 'remote markdown', contentMode: 'markdown', contentRevision: 8, isDirty: false });
  });

  it('does not deduplicate identical bytes requested in different content modes', async () => {
    open(pageId, 'start', 7);
    const first = held();
    vi.mocked(fetchWithAuth).mockReturnValueOnce(first.promise).mockResolvedValueOnce(answer({ contentRevision: 9 }));
    const { result } = renderHook(() => useDocument(pageId));
    type(result, 'same bytes');
    let saving!: Promise<boolean>;
    let queued!: Promise<boolean>;
    act(() => { saving = result.current.forceSave(); });
    act(() => { useDocumentManagerStore.getState().updateDocument(pageId, { contentMode: 'markdown' }); });
    act(() => { queued = result.current.forceSave(); });
    await act(async () => { first.release(answer({ contentRevision: 8 })); await saving; await queued; });
    expect(patchBodies()).toHaveLength(2);
    expect(patchBodies()[0]).toMatchObject({ content: 'same bytes', contentMode: 'html', expectedContentRevision: 7 });
    expect(patchBodies()[1]).toMatchObject({ content: 'same bytes', contentMode: 'markdown', expectedContentRevision: 8 });
  });

  describe('a slow load', () => {
    it('cannot put back the revision a save has moved past', async () => {
      open(pageId, 'start', 7);
      const load = held();
      vi.mocked(fetchWithAuth).mockReturnValueOnce(load.promise);
      vi.mocked(fetchWithAuth).mockResolvedValueOnce(answer({ contentRevision: 8 }));
      const { result } = renderHook(() => useDocument(pageId));

      let loading!: Promise<void>;
      act(() => {
        loading = result.current.initializeAndActivate();
      });
      type(result, 'saved text');
      await act(async () => {
        await result.current.forceSave();
      });

      await act(async () => {
        load.release(answer({ content: 'start', contentMode: 'html', contentRevision: 7 }));
        await loading;
      });

      expect(stored(pageId)).toMatchObject({ content: 'saved text', contentRevision: 8 });
    });

    it('does not let updateContentFromServer go backwards either', () => {
      open(pageId, 'newer', 8);
      const { result } = renderHook(() => useDocument(pageId));

      act(() => result.current.updateContentFromServer('older', 7));

      expect(stored(pageId)).toMatchObject({ content: 'newer', contentRevision: 8 });
    });
  });

  describe('a real change by someone else', () => {
    it('still parks a conflict, and never touches the local text', async () => {
      open(pageId, 'start', 7);
      vi.mocked(fetchWithAuth)
        .mockResolvedValueOnce(conflict(8, 7))
        .mockResolvedValueOnce(answer({ content: 'their text', contentRevision: 8 }));
      const { result } = renderHook(() => useDocument(pageId));

      type(result, 'my text');
      await act(async () => {
        await result.current.forceSave();
      });

      expect(useDocumentManagerStore.getState().conflicts.get(pageId)).toMatchObject({
        remoteContent: 'their text',
        remoteContentRevision: 8,
      });
      expect(stored(pageId)).toMatchObject({ content: 'my text', isDirty: true, contentRevision: 7 });
      expect(useDirtyStore.getState().isDirty(pageId)).toBe(true);
    });

    it('is not hidden by a load landing while there is unsaved text', async () => {
      // Today's bug in the other direction. The load used to hand the unsaved
      // text the newer revision, so the next save overwrote "their text" with
      // no prompt at all.
      open(pageId, 'start', 7);
      vi.mocked(fetchWithAuth)
        .mockResolvedValueOnce(answer({ content: 'their text', contentMode: 'html', contentRevision: 8 }))
        .mockResolvedValueOnce(conflict(8, 7))
        .mockResolvedValueOnce(answer({ content: 'their text', contentRevision: 8 }));
      const { result } = renderHook(() => useDocument(pageId));

      type(result, 'my text');
      await act(() => result.current.initializeAndActivate());

      expect(stored(pageId)).toMatchObject({ content: 'my text', contentRevision: 7 });

      await act(async () => {
        await result.current.forceSave();
      });

      expect(patchBodies()[0]).toMatchObject({ expectedContentRevision: 7 });
      expect(hasConflict(pageId)).toBe(true);
    });

    it('stops a save that was waiting behind the save that hit the conflict', async () => {
      open(pageId, 'start', 7);
      const first = held();
      vi.mocked(fetchWithAuth).mockReturnValueOnce(first.promise);
      vi.mocked(fetchWithAuth).mockResolvedValueOnce(answer({ content: 'their text', contentRevision: 8 }));
      const { result } = renderHook(() => useDocument(pageId));

      type(result, 'my text');
      let firstSave!: Promise<unknown>;
      act(() => {
        firstSave = result.current.forceSave();
      });
      type(result, 'more of my text');
      let waiting!: Promise<unknown>;
      act(() => {
        waiting = result.current.forceSave();
      });

      await act(async () => {
        first.release(conflict(8, 7));
        await Promise.all([firstSave, waiting]);
      });

      expect(patchBodies()).toHaveLength(1);
      expect(hasConflict(pageId)).toBe(true);
      expect(stored(pageId)?.content).toBe('more of my text');
    });
  });
});
