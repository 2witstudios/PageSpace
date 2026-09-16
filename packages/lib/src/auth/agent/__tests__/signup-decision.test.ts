/**
 * ADR 0005 Decisions 10/11 — the signup door decision. Precedence is fixed:
 * disabled | challenge_invalid | pow_invalid | tos_required, so a disabled
 * deployment never reveals challenge state and a bad challenge never reveals
 * whether the PoW would have passed.
 */
import { describe, it, expect } from 'vitest';
import { decideAgentSignup, type AgentSignupInput } from '../signup-decision';

function input(overrides: Partial<AgentSignupInput> = {}): AgentSignupInput {
  return {
    enabled: true,
    challenge: { found: true, expired: false, consumed: false, difficultyBits: 20 },
    powValid: true,
    tosAccepted: true,
    ...overrides,
  };
}

describe('decideAgentSignup', () => {
  it('returns ok with the challenge difficulty when everything holds', () => {
    expect(decideAgentSignup(input())).toEqual({ status: 'ok', difficultyBits: 20 });
  });

  it('returns disabled when the door is closed, regardless of every other input', () => {
    expect(decideAgentSignup(input({ enabled: false }))).toEqual({ status: 'disabled' });
    expect(
      decideAgentSignup(
        input({
          enabled: false,
          challenge: { found: false, expired: true, consumed: true, difficultyBits: 0 },
          powValid: false,
          tosAccepted: false,
        }),
      ),
    ).toEqual({ status: 'disabled' });
  });

  it('returns challenge_invalid for a missing challenge', () => {
    expect(
      decideAgentSignup(input({ challenge: { found: false, expired: false, consumed: false, difficultyBits: 20 } })),
    ).toEqual({ status: 'challenge_invalid' });
  });

  it('returns challenge_invalid for an expired challenge', () => {
    expect(
      decideAgentSignup(input({ challenge: { found: true, expired: true, consumed: false, difficultyBits: 20 } })),
    ).toEqual({ status: 'challenge_invalid' });
  });

  it('returns challenge_invalid for a consumed (single-use, already spent) challenge', () => {
    expect(
      decideAgentSignup(input({ challenge: { found: true, expired: false, consumed: true, difficultyBits: 20 } })),
    ).toEqual({ status: 'challenge_invalid' });
  });

  it('returns challenge_invalid for a challenge whose stored difficulty is out of the [1,64] policy range', () => {
    expect(
      decideAgentSignup(input({ challenge: { found: true, expired: false, consumed: false, difficultyBits: 0 } })),
    ).toEqual({ status: 'challenge_invalid' });
    expect(
      decideAgentSignup(input({ challenge: { found: true, expired: false, consumed: false, difficultyBits: 65 } })),
    ).toEqual({ status: 'challenge_invalid' });
  });

  it('reports challenge_invalid before pow_invalid and tos_required', () => {
    expect(
      decideAgentSignup(
        input({
          challenge: { found: false, expired: false, consumed: false, difficultyBits: 20 },
          powValid: false,
          tosAccepted: false,
        }),
      ),
    ).toEqual({ status: 'challenge_invalid' });
  });

  it('returns pow_invalid when the challenge is fine but the work is not', () => {
    expect(decideAgentSignup(input({ powValid: false }))).toEqual({ status: 'pow_invalid' });
  });

  it('reports pow_invalid before tos_required', () => {
    expect(decideAgentSignup(input({ powValid: false, tosAccepted: false }))).toEqual({ status: 'pow_invalid' });
  });

  it('returns tos_required when only the terms are missing', () => {
    expect(decideAgentSignup(input({ tosAccepted: false }))).toEqual({ status: 'tos_required' });
  });
});
