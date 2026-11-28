/**
 * Solve a signup challenge in the browser: in a web worker when the browser
 * has one, else on the main thread yielding between chunks. Resolves with the
 * nonce; rejects when the search gives up or is aborted.
 */
import { runPowSearch, type PowRunMessage, type PowRunRequest } from './pow-run';

interface SolveInBrowserInput extends PowRunRequest {
  onProgress: (attempts: number, expected: number) => void;
  signal?: AbortSignal;
}

class PowSearchFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PowSearchFailed';
  }
}

function settle(
  message: PowRunMessage,
  input: SolveInBrowserInput,
  resolve: (nonce: string) => void,
  reject: (error: Error) => void,
): boolean {
  if (message.type === 'progress') {
    input.onProgress(message.attempts, message.expected);
    return false;
  }
  if (message.type === 'solved') resolve(message.nonce);
  else reject(new PowSearchFailed('Proof of work gave up; fetch a fresh challenge and try again.'));
  return true;
}

export function solvePowInBrowser(input: SolveInBrowserInput): Promise<string> {
  const request: PowRunRequest = { challenge: input.challenge, difficultyBits: input.difficultyBits };

  return new Promise<string>((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new PowSearchFailed('aborted'));
      return;
    }

    if (typeof Worker === 'undefined') {
      let stopped = false;
      input.signal?.addEventListener('abort', () => {
        stopped = true;
        reject(new PowSearchFailed('aborted'));
      });
      void runPowSearch(
        request,
        (message) => {
          if (!stopped && settle(message, input, resolve, reject)) stopped = true;
        },
        () => (stopped ? Promise.reject(new PowSearchFailed('aborted')) : new Promise((next) => setTimeout(next, 0))),
      ).catch(() => {});
      return;
    }

    const worker = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' });
    const stop = () => worker.terminate();
    input.signal?.addEventListener('abort', () => {
      stop();
      reject(new PowSearchFailed('aborted'));
    });
    worker.onmessage = (event: MessageEvent<PowRunMessage>) => {
      if (settle(event.data, input, resolve, reject)) stop();
    };
    worker.onerror = () => {
      stop();
      reject(new PowSearchFailed('The proof-of-work worker failed to start.'));
    };
    worker.postMessage(request);
  });
}
