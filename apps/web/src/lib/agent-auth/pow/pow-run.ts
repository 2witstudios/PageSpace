/**
 * The chunked proof-of-work loop the web worker runs (and, where a browser has
 * no Worker, the page runs between animation frames). Reports progress after
 * every chunk so the page can say what it is doing; gives up after a bounded
 * number of attempts so a misconfigured difficulty can never spin forever.
 */
import { expectedPowAttempts, searchPowNonce } from './pow-solver';

export interface PowRunRequest {
  challenge: string;
  difficultyBits: number;
}

export type PowRunMessage =
  | { type: 'progress'; attempts: number; expected: number }
  | { type: 'solved'; nonce: string; attempts: number }
  | { type: 'failed'; attempts: number };

export const POW_CHUNK_SIZE = 20_000;

/** 32× the mean: the chance an honest search needs more is e^-32. */
const ATTEMPT_BUDGET_MULTIPLIER = 32;

export async function runPowSearch(
  request: PowRunRequest,
  post: (message: PowRunMessage) => void,
  pause: () => Promise<void>,
  options: { chunkSize?: number; maxAttempts?: number } = {},
): Promise<void> {
  const expected = expectedPowAttempts(request.difficultyBits);
  const chunkSize = options.chunkSize ?? POW_CHUNK_SIZE;
  const budget = options.maxAttempts ?? expected * ATTEMPT_BUDGET_MULTIPLIER;
  let attempts = 0;
  while (attempts < budget) {
    const count = Math.min(chunkSize, budget - attempts);
    const result = searchPowNonce({ challenge: request.challenge, difficultyBits: request.difficultyBits, start: attempts, count });
    if (result.nonce !== null) {
      post({ type: 'solved', nonce: result.nonce, attempts: attempts + result.attempts });
      return;
    }
    attempts += result.attempts;
    post({ type: 'progress', attempts, expected });
    await pause();
  }
  post({ type: 'failed', attempts });
}
