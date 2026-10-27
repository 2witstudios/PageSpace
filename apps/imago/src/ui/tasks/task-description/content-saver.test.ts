import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ApiError } from '@/api/errors';
import { createContentSaver, type SaveResult, type TimerId } from './content-saver';

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

const setup = (send: (html: string) => Promise<unknown> = async () => undefined) => {
  const clock = manualClock();
  const sent: string[] = [];
  const results: SaveResult[] = [];
  const saver = createContentSaver({
    send: async (html) => {
      sent.push(html);
      await send(html);
    },
    onResult: (result) => results.push(result),
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  return { clock, sent, results, saver };
};

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createContentSaver()', () => {
  test('a burst of edits', async () => {
    const { clock, sent, results, saver } = setup();
    saver.save('<p>a</p>');
    saver.save('<p>ab</p>');
    saver.save('<p>abc</p>');
    const before = [...sent];
    clock.tick();
    await flushPromises();

    assert({
      given: 'three edits before the pause',
      should: 'send nothing until the pause, then only the last',
      actual: { before, sent, results, timers: clock.pending() },
      expected: { before: [], sent: ['<p>abc</p>'], results: [{ ok: true }], timers: 0 },
    });
  });

  test('flush', async () => {
    const { clock, sent, saver } = setup();
    saver.save('<p>left</p>');
    await saver.flush();
    await saver.flush();

    assert({
      given: 'an edit, then leaving the field twice',
      should: 'send it at once, once, and cancel the pending pause',
      actual: { sent, timers: clock.pending() },
      expected: { sent: ['<p>left</p>'], timers: 0 },
    });
  });

  test('nothing to save', async () => {
    const { sent, results, saver } = setup();
    await saver.flush();

    assert({
      given: 'no edit',
      should: 'send nothing and report nothing',
      actual: { sent, results },
      expected: { sent: [], results: [] },
    });
  });

  test('a refusal', async () => {
    const { clock, results, saver } = setup(async () => {
      throw new ApiError({ status: 403, code: null, message: 'You need edit permission' });
    });
    saver.save('<p>x</p>');
    clock.tick();
    await flushPromises();

    assert({
      given: 'a save the server refuses',
      should: 'report the server’s words',
      actual: results,
      expected: [{ ok: false, refusal: 'You need edit permission' }],
    });
  });

  test('no answer', async () => {
    const { results, saver } = setup(async () => {
      throw new TypeError('Failed to fetch');
    });
    saver.save('<p>x</p>');
    await saver.flush();

    assert({
      given: 'a save that never reaches PageSpace',
      should: 'say so',
      actual: results,
      expected: [{ ok: false, refusal: 'Could not save the description' }],
    });
  });

  test('a slow save, then a newer edit', async () => {
    // A server that keeps the content of whichever PATCH lands last, and
    // answers each request only when the test says so.
    const clock = manualClock();
    let stored = '';
    let inFlight = 0;
    let mostInFlight = 0;
    const answers: (() => void)[] = [];
    const results: SaveResult[] = [];
    const saver = createContentSaver({
      send: (html) => {
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        return new Promise<void>((resolve) => {
          answers.push(() => {
            stored = html;
            inFlight -= 1;
            resolve();
          });
        });
      },
      onResult: (result) => results.push(result),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    saver.save('<p>A</p>');
    clock.tick();
    await flushPromises();
    saver.save('<p>AB</p>');
    clock.tick();
    await flushPromises();
    const sentWhileSlow = answers.length;
    // The newer save would answer first; then the older one.
    answers.at(-1)?.();
    await flushPromises();
    answers[0]?.();
    await flushPromises();
    answers.at(-1)?.();
    await flushPromises();
    await saver.flush();

    assert({
      given: 'an edit saved slowly, and a newer edit after the next pause',
      should: 'send one save at a time, so the newer text is what the server keeps',
      actual: { sentWhileSlow, mostInFlight, stored, results },
      expected: { sentWhileSlow: 1, mostInFlight: 1, stored: '<p>AB</p>', results: [{ ok: true }, { ok: true }] },
    });
  });

  test('edits while a save is slow', async () => {
    const answers: (() => void)[] = [];
    const sent: string[] = [];
    const saver = createContentSaver({
      send: (html) => {
        sent.push(html);
        return new Promise<void>((resolve) => answers.push(resolve));
      },
      onResult: () => {},
      schedule: (run) => {
        run();
        return 0;
      },
      cancel: () => {},
    });
    saver.save('<p>1</p>');
    saver.save('<p>12</p>');
    saver.save('<p>123</p>');
    await flushPromises();
    const first = [...sent];
    answers[0]?.();
    await flushPromises();
    answers[1]?.();
    await flushPromises();

    assert({
      given: 'three edits while the first save is still out',
      should: 'send only the latest once it is answered, skipping the superseded one',
      actual: { first, sent },
      expected: { first: ['<p>1</p>'], sent: ['<p>1</p>', '<p>123</p>'] },
    });
  });
});

