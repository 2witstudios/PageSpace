import { describe, it } from 'vitest';
import { assert } from './riteway.js';
import { decideWorkerExpiry } from '../decide-worker-expiry.js';

const IDLE = 15 * 60_000;

describe('decideWorkerExpiry', () => {
  it('keeps a worker that was instructed within the idle window, and says when to look again', () => {
    assert({
      given: 'a last accepted instruction 5 minutes ago and a 15 minute idle limit',
      should: 'keep running and re-check in 10 minutes',
      actual: decideWorkerExpiry({ lastInstructedAt: 0, now: 5 * 60_000, idleShutdownMs: IDLE }),
      expected: { expire: false, recheckInMs: 10 * 60_000 },
    });
  });

  it('expires a worker nobody has instructed for the idle window, so no profile outlives its session', () => {
    assert({
      given: 'no accepted instruction for exactly and for longer than the idle limit',
      should: 'expire both times',
      actual: [
        decideWorkerExpiry({ lastInstructedAt: 0, now: IDLE, idleShutdownMs: IDLE }),
        decideWorkerExpiry({ lastInstructedAt: 0, now: IDLE * 3, idleShutdownMs: IDLE }),
      ],
      expected: [{ expire: true }, { expire: true }],
    });
  });
});
