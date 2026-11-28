import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyPowSolution } from '@pagespace/lib/auth/agent/pow';
import { solvePowInBrowser, PowSearchFailed } from '../solve-in-browser';

const CHALLENGE = 'ps_pow_abcdefghijklmnopqrstuvwxyz012345';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('solvePowInBrowser', () => {
  it('given no Worker, should solve on the main thread and report progress', async () => {
    vi.stubGlobal('Worker', undefined);
    const onProgress = vi.fn();
    const nonce = await solvePowInBrowser({ challenge: CHALLENGE, difficultyBits: 12, onProgress });
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce, difficultyBits: 12 })).toBe(true);
  });

  it('given a Worker, should post the challenge, forward progress, resolve the nonce and terminate', async () => {
    const instances: FakeWorker[] = [];
    class FakeWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      posted: unknown[] = [];
      terminate = vi.fn();
      constructor(readonly url: URL, readonly options: WorkerOptions) {
        instances.push(this);
      }
      postMessage(message: unknown) {
        this.posted.push(message);
        queueMicrotask(() => {
          this.onmessage?.({ data: { type: 'progress', attempts: 20_000, expected: 1_048_576 } });
          this.onmessage?.({ data: { type: 'solved', nonce: '4242', attempts: 4243 } });
        });
      }
    }
    vi.stubGlobal('Worker', FakeWorker);
    const onProgress = vi.fn();

    const nonce = await solvePowInBrowser({ challenge: CHALLENGE, difficultyBits: 20, onProgress });

    expect(nonce).toBe('4242');
    expect(instances[0].posted).toEqual([{ challenge: CHALLENGE, difficultyBits: 20 }]);
    expect(instances[0].options).toEqual({ type: 'module' });
    expect(onProgress).toHaveBeenCalledWith(20_000, 1_048_576);
    expect(instances[0].terminate).toHaveBeenCalled();
  });

  it('given the worker gives up, should reject', async () => {
    class GivingUpWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      terminate = vi.fn();
      postMessage() {
        queueMicrotask(() => this.onmessage?.({ data: { type: 'failed', attempts: 10 } }));
      }
    }
    vi.stubGlobal('Worker', GivingUpWorker);
    await expect(solvePowInBrowser({ challenge: CHALLENGE, difficultyBits: 20, onProgress: vi.fn() })).rejects.toBeInstanceOf(PowSearchFailed);
  });

  it('given an already aborted signal, should reject without starting', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(solvePowInBrowser({ challenge: CHALLENGE, difficultyBits: 20, onProgress: vi.fn(), signal: controller.signal })).rejects.toBeInstanceOf(PowSearchFailed);
  });
});
