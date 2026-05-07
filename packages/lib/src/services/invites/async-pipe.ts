type AsyncStep = (input: unknown) => unknown | Promise<unknown>;

const isFailureResult = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'ok' in value &&
  (value as { ok: unknown }).ok === false;

export function asyncPipe<A>(): (input: A) => Promise<A>;
export function asyncPipe<A, B>(
  f1: (a: A) => B | Promise<B>,
): (input: A) => Promise<B>;
export function asyncPipe<A, B, C>(
  f1: (a: A) => B | Promise<B>,
  f2: (b: B) => C | Promise<C>,
): (input: A) => Promise<C>;
export function asyncPipe<A, B, C, D>(
  f1: (a: A) => B | Promise<B>,
  f2: (b: B) => C | Promise<C>,
  f3: (c: C) => D | Promise<D>,
): (input: A) => Promise<D>;
export function asyncPipe<A, B, C, D, E>(
  f1: (a: A) => B | Promise<B>,
  f2: (b: B) => C | Promise<C>,
  f3: (c: C) => D | Promise<D>,
  f4: (d: D) => E | Promise<E>,
): (input: A) => Promise<E>;
export function asyncPipe<A, B, C, D, E, F>(
  f1: (a: A) => B | Promise<B>,
  f2: (b: B) => C | Promise<C>,
  f3: (c: C) => D | Promise<D>,
  f4: (d: D) => E | Promise<E>,
  f5: (e: E) => F | Promise<F>,
): (input: A) => Promise<F>;
export function asyncPipe(...fns: AsyncStep[]): (input: unknown) => Promise<unknown> {
  return async (input: unknown): Promise<unknown> => {
    let value: unknown = await Promise.resolve(input);
    for (const fn of fns) {
      if (isFailureResult(value)) return value;
      value = await fn(value);
    }
    return value;
  };
}
