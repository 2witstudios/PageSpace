/**
 * The CLI's proof-of-work solver and secret-shape check are inlined copies (the
 * published CLI never runtime-imports `@pagespace/lib`). These drift guards pin
 * them to the server's own `verifyPowSolution` and `isAgentSecretShape` through
 * a devDependency-only import.
 */
import { describe, expect, it } from 'vitest';
import { verifyPowSolution } from '@pagespace/lib/auth/agent/pow';
import { isAgentSecretShape as libIsAgentSecretShape } from '@pagespace/lib/auth/agent/secret';
import { isAgentSecretShape, solveAgentPow } from '../agent-pow.js';

describe('solveAgentPow — drift guard vs the server verifier', () => {
  it('produces a nonce the server accepts, across difficulties', () => {
    for (const bits of [1, 4, 8, 12]) {
      const challenge = `ps_pow_test${bits}`;
      const nonce = solveAgentPow(challenge, bits);
      expect(verifyPowSolution({ challenge, nonce, difficultyBits: bits })).toBe(true);
    }
  });

  it('refuses a difficulty the server would never issue, instead of spinning', () => {
    expect(() => solveAgentPow('c', 0)).toThrow(RangeError);
    expect(() => solveAgentPow('c', 65)).toThrow(RangeError);
    expect(() => solveAgentPow('c', 1.5)).toThrow(RangeError);
  });

  it('gives up after the iteration budget rather than running forever', () => {
    expect(() => solveAgentPow('c', 64, 10)).toThrow(/budget/);
  });
});

describe('isAgentSecretShape — drift guard vs @pagespace/lib', () => {
  it('agrees with the server on accepted and refused shapes', () => {
    const samples = [
      'ps_agent_abcdefghijklmnopqrstuvwxyz012345',
      'ps_agent_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      'ps_agent_short',
      'ps_rt_abcdefghijklmnopqrstuvwxyz012345',
      ' ps_agent_abcdefghijklmnopqrstuvwxyz012345',
      '',
    ];
    for (const sample of samples) {
      expect(isAgentSecretShape(sample)).toBe(libIsAgentSecretShape(sample));
    }
  });
});
