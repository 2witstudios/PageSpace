import { describe, expect, it } from 'vitest';
import { readBodyWithCap, readBytesWithCap } from '../read-body-with-cap';

/** A request whose body arrives in chunks with no Content-Length, as a chunked upload does. */
function chunked(chunks: Uint8Array[]): { request: Request; pulled: () => number } {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks.length) return controller.close();
      controller.enqueue(chunks[pulled]);
      pulled += 1;
    },
  });
  const request = new Request('http://x/', { method: 'POST', body, duplex: 'half' } as RequestInit);
  return { request, pulled: () => pulled };
}

describe('readBytesWithCap', () => {
  it('returns the bytes of a body within the cap', async () => {
    const { request } = chunked([new Uint8Array([1, 2]), new Uint8Array([3])]);
    await expect(readBytesWithCap(request, 3)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it('stops reading as soon as the cap is passed, without buffering the rest', async () => {
    const { request, pulled } = chunked([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)]);
    await expect(readBytesWithCap(request, 6)).resolves.toBeNull();
    expect(pulled()).toBeLessThan(4);
  });

  it('answers past the cap without waiting on a cancellation that fails', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        return Promise.reject(new Error('cancel failed'));
      },
    });
    const request = new Request('http://x/', { method: 'POST', body, duplex: 'half' } as RequestInit);
    await expect(readBytesWithCap(request, 6)).resolves.toBeNull();
    expect(pulled).toBeGreaterThan(0);
  });

  it('a request with no body reads as empty', async () => {
    await expect(readBytesWithCap(new Request('http://x/', { method: 'POST' }), 3)).resolves.toEqual(new Uint8Array(0));
  });
});

describe('readBodyWithCap', () => {
  it('still reads text, and null past the cap', async () => {
    await expect(readBodyWithCap(chunked([new TextEncoder().encode('héllo')]).request, 100)).resolves.toBe('héllo');
    await expect(readBodyWithCap(chunked([new TextEncoder().encode('hello')]).request, 2)).resolves.toBeNull();
  });
});
