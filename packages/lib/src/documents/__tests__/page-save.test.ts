import { describe, it, expect, vi } from 'vitest';
import { createPageSaveSerializer, isOwnUnconfirmedSave } from '../page-save';

/** A save the test finishes by hand, so overlap can be arranged exactly. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createPageSaveSerializer', () => {
  it('sends a lone save at once and answers with its result', async () => {
    const saves = createPageSaveSerializer<string>();
    const send = vi.fn(async () => 'saved');

    await expect(saves.run('page-1', 'text', send)).resolves.toBe('saved');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('holds a second save until the first has answered', async () => {
    const saves = createPageSaveSerializer<string>();
    const first = deferred<string>();
    const second = vi.fn(async () => 'second');

    const running = saves.run('page-1', 'one', () => first.promise);
    const waiting = saves.run('page-1', 'two', second);
    await tick();
    expect(second).not.toHaveBeenCalled();

    first.resolve('first');
    await expect(running).resolves.toBe('first');
    await expect(waiting).resolves.toBe('second');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('sends only the newest of the saves that waited, and answers them all with it', async () => {
    const saves = createPageSaveSerializer<string>();
    const first = deferred<string>();
    const superseded = vi.fn(async () => 'superseded');
    const newest = vi.fn(async () => 'newest');

    const running = saves.run('page-1', 'one', () => first.promise);
    const older = saves.run('page-1', 'two', superseded);
    const latest = saves.run('page-1', 'three', newest);

    first.resolve('first');
    await running;

    await expect(older).resolves.toBe('newest');
    await expect(latest).resolves.toBe('newest');
    expect(superseded).not.toHaveBeenCalled();
    expect(newest).toHaveBeenCalledTimes(1);
  });

  it('does not resend what the save just answered carried', async () => {
    const saves = createPageSaveSerializer<string>();
    const first = deferred<string>();
    const repeat = vi.fn(async () => 'repeat');

    const running = saves.run('page-1', 'same', () => first.promise);
    const waiting = saves.run('page-1', 'same', repeat);

    first.resolve('first');
    await running;

    await expect(waiting).resolves.toBe('first');
    expect(repeat).not.toHaveBeenCalled();
  });

  it('sends a waiting save after the one before it failed, even with the same text', async () => {
    const saves = createPageSaveSerializer<string>();
    const first = deferred<string>();
    const retry = vi.fn(async () => 'retried');

    const running = saves.run('page-1', 'same', () => first.promise);
    const waiting = saves.run('page-1', 'same', retry);

    first.reject(new Error('offline'));
    await expect(running).rejects.toThrow('offline');
    await expect(waiting).resolves.toBe('retried');
  });

  it('rejects every waiter when the save they share fails', async () => {
    const saves = createPageSaveSerializer<string>();
    const first = deferred<string>();

    const running = saves.run('page-1', 'one', () => first.promise);
    const older = saves.run('page-1', 'two', async () => 'unused');
    const latest = saves.run('page-1', 'three', async () => {
      throw new Error('refused');
    });

    first.resolve('first');
    await running;

    await expect(older).rejects.toThrow('refused');
    await expect(latest).rejects.toThrow('refused');
  });

  it('keeps pages independent', async () => {
    const saves = createPageSaveSerializer<string>();
    const first = deferred<string>();
    const otherPage = vi.fn(async () => 'other');

    const running = saves.run('page-1', 'one', () => first.promise);
    await expect(saves.run('page-2', 'two', otherPage)).resolves.toBe('other');

    first.resolve('first');
    await running;
  });

  it('is ready for the next save once it has drained', async () => {
    const saves = createPageSaveSerializer<string>();

    await saves.run('page-1', 'one', async () => 'first');
    const next = vi.fn(async () => 'next');

    await expect(saves.run('page-1', 'one', next)).resolves.toBe('next');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('runs a send that reads shared state only when its turn comes', async () => {
    const saves = createPageSaveSerializer<number>();
    const first = deferred<number>();
    let revision = 1;

    const running = saves.run('page-1', 'one', async () => {
      const result = await first.promise;
      revision = result;
      return result;
    });
    const waiting = saves.run('page-1', 'two', async () => revision);

    first.resolve(2);
    await running;

    await expect(waiting).resolves.toBe(2);
  });
});

describe('isOwnUnconfirmedSave', () => {
  it('recognises the stored text as a save this client never heard back about', () => {
    expect(isOwnUnconfirmedSave('sent earlier', 'sent earlier')).toBe(true);
  });

  it('does not claim text someone else wrote', () => {
    expect(isOwnUnconfirmedSave('their text', 'sent earlier')).toBe(false);
  });

  it('claims nothing when no save is unconfirmed', () => {
    expect(isOwnUnconfirmedSave('', undefined)).toBe(false);
  });

  it('claims nothing when the stored text is unknown', () => {
    expect(isOwnUnconfirmedSave(undefined, 'sent earlier')).toBe(false);
    expect(isOwnUnconfirmedSave(null, 'sent earlier')).toBe(false);
  });
});
