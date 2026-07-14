import { describe, it, expect } from 'vitest';
import { shouldAttachStream } from '../shouldAttachStream';

describe('shouldAttachStream', () => {
  it('given a stream this context is already consuming over the POST body, should decline (attaching twice renders every token twice)', () => {
    expect(shouldAttachStream({ isOwn: true, isConsuming: true })).toBe(false);
  });

  // The reload property. `browserSessionId` lives in sessionStorage and SURVIVES a
  // reload; the consuming set is module state and does not. Under the old blanket
  // own-session skip, a reloaded tab still looked like the originator and dropped its
  // own stream forever — no bubble, no Stop button, live input, while the server kept
  // generating and editing pages.
  it('given an own stream this context is NOT consuming (a reloaded tab), should attach', () => {
    expect(shouldAttachStream({ isOwn: true, isConsuming: false })).toBe(true);
  });

  // A page channel carries streams from other users and other conversations. Skipping
  // purely on `isConsuming` would take multiplayer down as collateral damage.
  it('given a remote stream while this context consumes its own on the same channel, should still attach', () => {
    expect(shouldAttachStream({ isOwn: false, isConsuming: true })).toBe(true);
  });

  it('given a remote stream and nothing being consumed, should attach', () => {
    expect(shouldAttachStream({ isOwn: false, isConsuming: false })).toBe(true);
  });
});
