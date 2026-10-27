import { describe, it, expect } from 'vitest';
import { isOwnStream } from '../isOwnStream';
import { isOwnTabEcho } from '../isOwnTabEcho';

/**
 * The two questions this pair separates, and the bug that came from conflating them.
 *
 * "Is this stream mine?" is about a USER and must be true in every tab and on every device that
 * account is signed in to. "Did this tab already do this?" is about a TAB and must be FALSE in
 * the user's other tabs, because those tabs have not applied the change and do need the
 * broadcast. One predicate answered both, keyed on `browserSessionId`, so the second browser or
 * the second tab saw its own account's generation as a stranger's — no Stop button, attributed
 * to nobody.
 */
describe('isOwnStream — ownership is a USER question', () => {
  it('given the same user, should be their own stream', () => {
    expect(isOwnStream({ userId: 'user-1' }, 'user-1')).toBe(true);
  });

  it('given the same account in a second tab or on another device, should still be their own stream', () => {
    // The whole point of the change. `triggeredBy` here came from a DIFFERENT browser session —
    // the user's phone, or a second monitor — and it is still the same person's generation, so
    // it renders as theirs and its Stop works.
    expect(isOwnStream({ userId: 'user-1' }, 'user-1')).toBe(true);
  });

  it('given another member\'s stream on a shared page, should never be their own', () => {
    // A shared agent page: a colleague's reply is live content worth SHOWING, but it is not
    // this user's to stop — the server's abort is user-scoped, so a Stop wired to it would
    // report 'not_found' and silently do nothing.
    expect(isOwnStream({ userId: 'user-2' }, 'user-1')).toBe(false);
  });

  it('given an unresolved local identity, should FAIL CLOSED rather than claim the stream', () => {
    // Auth hydrates asynchronously. Claiming ownership before it resolves would render a
    // stranger's stream on a shared page as the viewer's own, with a Stop button that aborts
    // someone else's generation.
    expect(isOwnStream({ userId: 'user-1' }, undefined)).toBe(false);
    expect(isOwnStream({ userId: 'user-1' }, null)).toBe(false);
    expect(isOwnStream({ userId: 'user-1' }, '')).toBe(false);
  });

  it('given two empty ids, should still be false — an empty id is a placeholder, never an account', () => {
    // The predicate this replaces returned TRUE here, matching "identity even on the SSR
    // placeholder". Under user scoping that would make every anonymous stream everyone's.
    expect(isOwnStream({ userId: '' }, '')).toBe(false);
  });
});

describe('isOwnTabEcho — dedup is a TAB question', () => {
  it('given the event this tab caused, should be an echo to drop', () => {
    expect(isOwnTabEcho({ browserSessionId: 'session-A' }, 'session-A')).toBe(true);
  });

  it('given the same user\'s OTHER tab, should NOT be an echo — that tab has not applied it', () => {
    // The mirror-image error. Answering this question with `userId` would make the user's other
    // tab drop every event it actually needed, and it would go quietly stale.
    expect(isOwnTabEcho({ browserSessionId: 'session-B' }, 'session-A')).toBe(false);
  });

  it('given an unknown local session id, should FAIL OPEN', () => {
    // The safe direction here is the opposite of ownership's: a missed echo filter costs a
    // de-duplicated re-apply (every consumer dedups by message id), while a spurious filter
    // drops a real remote event.
    expect(isOwnTabEcho({ browserSessionId: 'session-A' }, '')).toBe(false);
  });
});
