import type { FetchOptions, QueuedRequest } from './types';

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export function validateRequestUrl(url: string): void {
  if (url.startsWith('/') && !url.startsWith('//')) {
    return;
  }

  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : undefined);
    if (typeof window !== 'undefined' && parsed.origin !== window.location.origin) {
      throw new RequestValidationError(`Cross-origin request blocked: ${parsed.origin}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new RequestValidationError(`Unsafe URL scheme: ${parsed.protocol}`);
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new RequestValidationError('Invalid URL');
    }
    throw error;
  }
}

export interface RequestQueue {
  enqueue(url: string, options?: FetchOptions): Promise<Response>;
  dequeueAll(): QueuedRequest[];
  readonly length: number;
}

export function createRequestQueue(): RequestQueue {
  const queue: QueuedRequest[] = [];

  function enqueue(url: string, options?: FetchOptions): Promise<Response> {
    return new Promise((resolve, reject) => {
      queue.push({ resolve, reject, url, options });
    });
  }

  function dequeueAll(): QueuedRequest[] {
    const items = [...queue];
    queue.length = 0;
    return items;
  }

  return {
    enqueue,
    dequeueAll,
    get length() { return queue.length; }
  };
}
