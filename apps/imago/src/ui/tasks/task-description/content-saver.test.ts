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
});
