/**
 * The spawn-refusal classification — the pure decision behind the page's
 * fallback to a plain conversation. What matters: a QUOTA refusal (429) is the
 * one the user must HEAR about (they hold the capability and merely ran out of
 * allowance — silence reads as a permissions problem), while every other
 * refusal is the by-design silent degrade ("no workspace for you" is never
 * "no conversation").
 */
import { describe, it, expect } from 'vitest';

import { classifySpawnRefusal } from '../spawn-refusal';

describe('classifySpawnRefusal', () => {
  it("a 429 is a QUOTA refusal, carrying the server's own message", () => {
    const refusal = classifySpawnRefusal(429, 'You have 100 active sessions — end some before starting more.');
    expect(refusal.kind).toBe('quota');
    expect(refusal.message).toBe('You have 100 active sessions — end some before starting more.');
  });

  it('a 429 with no readable body still explains itself', () => {
    const refusal = classifySpawnRefusal(429, null);
    expect(refusal.kind).toBe('quota');
    expect(refusal.message.length).toBeGreaterThan(0);
  });

  it('a 403 is a capability refusal — the silent degrade', () => {
    const refusal = classifySpawnRefusal(403, 'Insufficient permissions to use this agent');
    expect(refusal.kind).toBe('capability');
    expect(refusal.message).toBe('Insufficient permissions to use this agent');
  });

  it('an unexpected failure (5xx) counts as capability, never quota', () => {
    // "Could not have a workspace right now" and "not allowed one" degrade the
    // same way; only the allowance case earns the interruption.
    expect(classifySpawnRefusal(502, null).kind).toBe('capability');
    expect(classifySpawnRefusal(500, 'Could not start a session').kind).toBe('capability');
  });
});
