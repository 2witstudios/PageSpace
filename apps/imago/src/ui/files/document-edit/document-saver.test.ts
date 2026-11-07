import { describe, test, expect } from 'vitest';
import { assert } from 'riteway/vitest';
import { ApiError } from '@/api/errors';
import {
  createDocumentSaver,
  type DocumentPatch,
  type SaverState,
  type TimerId,
} from './document-saver';

/** A clock the test turns by hand: schedule() queues, tick() runs what is due. */
const manualClock = () => {
  let next = 0;
  const timers = new Map<number, () => void>();
  return {
    schedule: (run: () => void) => {
      next += 1;
      timers.set(next, run);
      return next;
    },
    cancel: (id: TimerId | undefined) => {
      if (typeof id === 'number') timers.delete(id);
    },
    tick: () => {
      const due = [...timers.values()];
      timers.clear();
      due.forEach((run) => run());
    },
    pending: () => timers.size,
  };
};

type Sent = { readonly patch: DocumentPatch; readonly expectedContentRevision: number };

const refused = (status: number, message = 'refused', code: string | null = null) =>
  new ApiError({ status, code, message });

/** answer() decides each send's fate; a contentRevision number is a save that landed. */
const setup = (answer: (sent: Sent, index: number) => Promise<number> = async (sent) => sent.expectedContentRevision + 1) => {
  const clock = manualClock();
  const sent: Sent[] = [];
  const states: SaverState[] = [];
  const saver = createDocumentSaver({
    contentRevision: 4,
    send: async (patch, expectedContentRevision) => {
      const entry = { patch, expectedContentRevision };
      sent.push(entry);
      return { contentRevision: await answer(entry, sent.length - 1) };
    },
    onState: (state) => states.push(state),
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  return { clock, sent, states, saver };
};

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createDocumentSaver()', () => {
  test('a title-only answer cannot move the baseline of an unseen body', async () => {
    const { saver, sent } = setup(async (entry, index) => {
      if (index === 0) return 5;
      if (entry.expectedContentRevision !== 5) throw refused(409);
      return 6;
    });
    await saver.rename('Plan');
    expect(saver.contentRevision()).toBe(4);
    saver.edit('<p>Stored plus my typing</p>');
    expect(await saver.flush()).toBe('conflict');
    expect(sent[1].expectedContentRevision).toBe(4);
    expect(saver.unsaved()).toEqual({ content: '<p>Stored plus my typing</p>' });
  });

  test('a burst of edits', async () => {
    const { clock, sent, states, saver } = setup();
    saver.edit('<p>a</p>');
    saver.edit('<p>ab</p>');
    saver.edit('<p>abc</p>');
    const before = [...sent];
    clock.tick();
    await flushPromises();
    assert({
      given: 'three edits before typing pauses',
      should: 'send nothing until the pause, then only the last, against the contentRevision it opened with',
      actual: { before, sent, kinds: states.map((state) => state.status.kind), editing: saver.isEditing() },
      expected: {
        before: [],
        sent: [{ patch: { content: '<p>abc</p>' }, expectedContentRevision: 4 }],
        kinds: ['unsaved', 'saving', 'saved'],
        editing: false,
      },
    });
  });

  test('saves in a row', async () => {
    const { clock, sent, saver } = setup();
    saver.edit('<p>one</p>');
    clock.tick();
    await flushPromises();
    saver.edit('<p>two</p>');
    clock.tick();
    await flushPromises();
    assert({
      given: 'a second save after the first landed',
      should: 'send it against the contentRevision the first save answered with',
      actual: sent.map((entry) => entry.expectedContentRevision),
      expected: [4, 5],
    });
  });

  test('typing while a save is out', async () => {
    let release: (contentRevision: number) => void = () => {};
    const { clock, sent, saver } = setup((entry, index) =>
      index === 0 ? new Promise<number>((resolve) => (release = resolve)) : Promise.resolve(entry.expectedContentRevision + 1),
    );
    saver.edit('<p>first</p>');
    clock.tick();
    saver.edit('<p>second</p>');
    const flushing = saver.flush();
    const whileOut = [...sent];
    const editingWhileOut = saver.isEditing();
    release(5);
    await flushing;
    assert({
      given: 'an edit and a flush while the previous save has not answered',
      should: 'stay editing, wait for the answer, then send only the newer text against the new revision',
      actual: { whileOut: whileOut.length, editingWhileOut, sent, editing: saver.isEditing() },
      expected: {
        whileOut: 1,
        editingWhileOut: true,
        sent: [
          { patch: { content: '<p>first</p>' }, expectedContentRevision: 4 },
          { patch: { content: '<p>second</p>' }, expectedContentRevision: 5 },
        ],
        editing: false,
      },
    });
  });

  test('a rename', async () => {
    const { clock, sent, saver } = setup();
    saver.edit('<p>typed</p>');
    const outcome = await saver.rename('Plan');
    assert({
      given: 'a title committed while text waits for its pause',
      should: 'save both at once, in one PATCH, and cancel the pending timer',
      actual: { outcome, sent, timers: clock.pending() },
      expected: { outcome: 'saved', sent: [{ patch: { content: '<p>typed</p>', title: 'Plan' }, expectedContentRevision: 4 }], timers: 0 },
    });
  });

  test('a 409 conflict', async () => {
    const { clock, sent, states, saver } = setup(async (entry, index) => {
      if (index === 0) throw refused(409, 'Page was modified');
      return entry.expectedContentRevision + 1;
    });
    saver.edit('<p>mine</p>');
    clock.tick();
    await flushPromises();
    saver.edit('<p>mine, more</p>');
    const scheduled = clock.pending();
    const flushed = await saver.flush();
    assert({
      given: 'a save the server refuses as a conflict, then more typing and a flush',
      should: 'keep the text pending, stop saving it, and stay editing so nothing reloads over it',
      actual: {
        sent: sent.length,
        status: states.at(-1)?.status,
        scheduled,
        flushed,
        editing: saver.isEditing(),
        unsaved: saver.unsaved(),
      },
      expected: {
        sent: 1,
        status: { kind: 'conflict' },
        scheduled: 0,
        flushed: 'conflict',
        editing: true,
        unsaved: { content: '<p>mine, more</p>' },
      },
    });
  });

  test('resolving a conflict by keeping mine', async () => {
    const { clock, sent, states, saver } = setup(async (entry, index) => {
      if (index === 0) throw refused(409);
      return entry.expectedContentRevision + 1;
    });
    saver.edit('<p>mine</p>');
    clock.tick();
    await flushPromises();
    const outcome = await saver.keepMine(9);
    assert({
      given: 'a parked conflict the viewer settles by keeping their text against the contentRevision now stored',
      should: 'send the kept text against that contentRevision and be saved',
      actual: { outcome, last: sent.at(-1), status: states.at(-1)?.status, editing: saver.isEditing() },
      expected: {
        outcome: 'saved',
        last: { patch: { content: '<p>mine</p>' }, expectedContentRevision: 9 },
        status: { kind: 'saved' },
        editing: false,
      },
    });
  });

  test('adopting the server copy', async () => {
    const { clock, sent, states, saver } = setup(async () => {
      throw refused(409);
    });
    saver.edit('<p>mine</p>');
    clock.tick();
    await flushPromises();
    saver.adopt(9);
    saver.edit('<p>after</p>');
    clock.tick();
    await flushPromises();
    assert({
      given: 'the viewer takes the stored version, then types again',
      should: 'drop the parked text and save the new edit against the adopted revision',
      actual: { last: sent.at(-1), adoptedStatus: states.find((state) => state.status.kind === 'saved')?.status },
      expected: { last: { patch: { content: '<p>after</p>' }, expectedContentRevision: 9 }, adoptedStatus: { kind: 'saved' } },
    });
  });

  test('a 403', async () => {
    const { clock, sent, states, saver } = setup(async () => {
      throw refused(403, 'You need edit permission to modify this page');
    });
    saver.edit('<p>mine</p>');
    clock.tick();
    await flushPromises();
    saver.edit('<p>mine, more</p>');
    await saver.flush();
    assert({
      given: 'a save the server refuses for lack of edit rights',
      should: 'turn read-only, keep the text, and send nothing more',
      actual: { sent: sent.length, status: states.at(-1)?.status, unsaved: saver.unsaved(), timers: clock.pending() },
      expected: { sent: 1, status: { kind: 'read-only' }, unsaved: { content: '<p>mine, more</p>' }, timers: 0 },
    });
  });

  test('a failed save', async () => {
    const { clock, sent, states, saver } = setup(async (entry, index) => {
      if (index === 0) throw new TypeError('Failed to fetch');
      return entry.expectedContentRevision + 1;
    });
    saver.edit('<p>mine</p>');
    clock.tick();
    await flushPromises();
    const failed = states.at(-1)?.status;
    const keptWhileFailed = saver.unsaved();
    const retried = await saver.flush();
    assert({
      given: 'a save that never reached the server, then a retry',
      should: 'say it failed and keep the text, then send the same text again and be saved',
      actual: { failed, keptWhileFailed, retried, sent: sent.map((entry) => entry.patch), unsaved: saver.unsaved() },
      expected: {
        failed: { kind: 'failed', message: 'Could not reach PageSpace. Your text is kept here.' },
        keptWhileFailed: { content: '<p>mine</p>' },
        retried: 'saved',
        sent: [{ content: '<p>mine</p>' }, { content: '<p>mine</p>' }],
        unsaved: null,
      },
    });
  });

  test('a server error', async () => {
    const { clock, states, saver } = setup(async () => {
      throw refused(500, 'Failed to update page');
    });
    saver.edit('<p>mine</p>');
    clock.tick();
    await flushPromises();
    assert({
      given: 'a save the server fails',
      should: 'carry its message',
      actual: states.at(-1)?.status,
      expected: { kind: 'failed', message: 'Failed to update page' },
    });
  });

  test('state notices', async () => {
    const { clock, states, saver } = setup();
    saver.edit('<p>a</p>');
    saver.edit('<p>ab</p>');
    clock.tick();
    await flushPromises();
    assert({
      given: 'several edits in one unsaved stretch',
      should: 'tell the view only when the state changes, with whether it is editing',
      actual: states,
      expected: [
        { status: { kind: 'unsaved' }, editing: true },
        { status: { kind: 'saving' }, editing: true },
        { status: { kind: 'saved' }, editing: false },
      ],
    });
  });

  test('a flush with nothing to save', async () => {
    const { sent, states, saver } = setup();
    const outcome = await saver.flush();
    assert({
      given: 'no edit since the last save',
      should: 'send nothing',
      actual: { outcome, sent, states },
      expected: { outcome: 'saved', sent: [], states: [] },
    });
  });

  test('a CSRF rejection that outlives the client’s retry', async () => {
    const { clock, sent, states, saver } = setup(async (entry, index) => {
      if (index === 0) throw refused(403, 'CSRF token invalid', 'CSRF_TOKEN_INVALID');
      return entry.expectedContentRevision + 1;
    });
    saver.edit('<p>mine</p>');
    clock.tick();
    await flushPromises();
    const status = states.at(-1)?.status;
    const retried = await saver.flush();
    assert({
      given: 'a save refused for its CSRF token, not for the viewer’s rights',
      should: 'fail with a session message the viewer can retry from, stay editable, then save on retry',
      actual: { status, retried, sent: sent.length, unsaved: saver.unsaved() },
      expected: {
        status: { kind: 'failed', message: 'Your session could not be confirmed. Your text is kept here: try again, or reload the page.' },
        retried: 'saved',
        sent: 2,
        unsaved: null,
      },
    });
  });

  test('restoring a draft kept from before', async () => {
    const { clock, sent, states, saver } = setup();
    saver.restore({ content: '<p>kept</p>', title: 'Kept' }, 7);
    const scheduled = clock.pending();
    clock.tick();
    await flushPromises();
    assert({
      given: 'text the server never got, kept from when the document was last open at contentRevision 7',
      should: 'hold it as unsaved and save it after the pause against that revision',
      actual: { scheduled, first: states[0], sent, contentRevision: saver.contentRevision() },
      expected: {
        scheduled: 1,
        first: { status: { kind: 'unsaved' }, editing: true },
        sent: [{ patch: { content: '<p>kept</p>', title: 'Kept' }, expectedContentRevision: 7 }],
        contentRevision: 8,
      },
    });
  });

  test('a rename elsewhere does not concern the saver', async () => {
    const { clock, sent, saver } = setup();
    saver.edit('<p>mine</p>');
    clock.tick();
    await flushPromises();
    assert({
      given: 'a save after any number of writes to the page that left its text alone',
      should: 'send only the content revision it holds',
      actual: sent,
      expected: [{ patch: { content: '<p>mine</p>' }, expectedContentRevision: 4 }],
    });
  });
});

describe('a save that was stored but never answered', () => {
  /** A saver whose first save never gets an answer, and whose next is refused by it. */
  const afterLostAnswer = (stored: { readonly contentRevision: number; readonly content: string }, retry: () => Promise<number>) => {
    const clock = manualClock();
    const sent: Sent[] = [];
    const states: SaverState[] = [];
    const saver = createDocumentSaver({
      contentRevision: 4,
      send: async (patch, expectedContentRevision) => {
        sent.push({ patch, expectedContentRevision });
        if (sent.length === 1) throw new TypeError('Failed to fetch');
        if (sent.length === 2) throw refused(409);
        return { contentRevision: await retry() };
      },
      readStored: async () => stored,
      onState: (state) => states.push(state),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    return { sent, states, saver };
  };

  test('does not claim identical bytes after a remote content mode conversion', async () => {
    const clock = manualClock();
    let sends = 0;
    const saver = createDocumentSaver({
      contentRevision: 4,
      send: async () => {
        sends += 1;
        if (sends === 1) throw new TypeError('lost response');
        if (sends === 2) throw refused(409);
        return { contentRevision: 7 };
      },
      readStored: async () => ({ contentRevision: 6, content: '', contentMode: 'markdown' as const }),
      onState: () => {}, schedule: clock.schedule, cancel: clock.cancel,
    });
    saver.edit('');
    await saver.flush();
    saver.edit('<p>local HTML typing</p>');
    expect(await saver.flush()).toBe('conflict');
    expect(sends).toBe(2);
    expect(saver.unsaved()).toEqual({ content: '<p>local HTML typing</p>' });
  });

  test('its own text behind a refusal', async () => {
    const { sent, saver } = afterLostAnswer({ contentRevision: 5, content: '<p>first</p>' }, async () => 6);
    saver.edit('<p>first</p>');
    await saver.flush();
    saver.edit('<p>more</p>');
    const outcome = await saver.flush();
    assert({
      given: 'a 409 while the stored text is exactly what the unanswered save sent',
      should: 'carry on from where that save left the text, with no conflict',
      actual: { outcome, last: sent.at(-1), contentRevision: saver.contentRevision(), unsaved: saver.unsaved() },
      expected: {
        outcome: 'saved',
        last: { patch: { content: '<p>more</p>' }, expectedContentRevision: 5 },
        contentRevision: 6,
        unsaved: null,
      },
    });
  });

  test('another writer behind a refusal', async () => {
    const { sent, saver } = afterLostAnswer({ contentRevision: 5, content: '<p>theirs</p>' }, async () => 6);
    saver.edit('<p>first</p>');
    await saver.flush();
    saver.edit('<p>more</p>');
    const outcome = await saver.flush();
    assert({
      given: 'a 409 while the stored text is not what the unanswered save sent',
      should: 'stop and keep the text for the viewer to settle',
      actual: { outcome, sends: sent.length, unsaved: saver.unsaved() },
      expected: { outcome: 'conflict', sends: 2, unsaved: { content: '<p>more</p>' } },
    });
  });

  test('a retry refused again', async () => {
    const { sent, saver } = afterLostAnswer({ contentRevision: 5, content: '<p>first</p>' }, async () => {
      throw refused(409);
    });
    saver.edit('<p>first</p>');
    await saver.flush();
    saver.edit('<p>more</p>');
    const outcome = await saver.flush();
    assert({
      given: 'a claim of its own save whose retry is refused too',
      should: 'ask, rather than try again',
      actual: { outcome, sends: sent.length },
      expected: { outcome: 'conflict', sends: 3 },
    });
  });

  test('a definite refusal', async () => {
    const clock = manualClock();
    let stored = false;
    const saver = createDocumentSaver({
      contentRevision: 4,
      send: async () => {
        throw refused(stored ? 409 : 400);
      },
      readStored: async () => ({ contentRevision: 5, content: '<p>first</p>' }),
      onState: () => {},
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    saver.edit('<p>first</p>');
    await saver.flush();
    stored = true;
    const outcome = await saver.flush();
    assert({
      given: 'a save the server definitely turned away, then a 409',
      should: 'not claim the stored text as its own',
      actual: outcome,
      expected: 'conflict',
    });
  });
});
