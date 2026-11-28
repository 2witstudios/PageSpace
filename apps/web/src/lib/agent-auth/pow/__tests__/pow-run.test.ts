import { describe, it, expect } from 'vitest';
import { verifyPowSolution } from '@pagespace/lib/auth/agent/pow';
import { runPowSearch, type PowRunMessage } from '../pow-run';

const CHALLENGE = 'ps_pow_abcdefghijklmnopqrstuvwxyz012345';

const collect = async (difficultyBits: number, chunkSize: number) => {
  const messages: PowRunMessage[] = [];
  let pauses = 0;
  await runPowSearch({ challenge: CHALLENGE, difficultyBits }, (m) => messages.push(m), async () => { pauses += 1; }, { chunkSize });
  return { messages, pauses };
};

describe('runPowSearch', () => {
  it('should report progress after every unsolved chunk, then a nonce the server verifies', async () => {
    const { messages, pauses } = await collect(10, 50);
    const last = messages[messages.length - 1];
    expect(last.type).toBe('solved');
    if (last.type !== 'solved') return;
    expect(verifyPowSolution({ challenge: CHALLENGE, nonce: last.nonce, difficultyBits: 10 })).toBe(true);
    const progress = messages.filter((m) => m.type === 'progress');
    expect(progress.length).toBe(pauses);
    progress.forEach((m, i) => expect(m).toEqual({ type: 'progress', attempts: (i + 1) * 50, expected: 1024 }));
    expect(last.attempts).toBe(Number(last.nonce) + 1);
  });

  it('given a puzzle it cannot solve within the attempt budget, should report failed rather than spin', async () => {
    const messages: PowRunMessage[] = [];
    await runPowSearch({ challenge: CHALLENGE, difficultyBits: 40 }, (m) => messages.push(m), async () => {}, { chunkSize: 30, maxAttempts: 100 });
    expect(messages.map((m) => m.attempts)).toEqual([30, 60, 90, 100, 100]);
    expect(messages[messages.length - 1]).toEqual({ type: 'failed', attempts: 100 });
  });
});
