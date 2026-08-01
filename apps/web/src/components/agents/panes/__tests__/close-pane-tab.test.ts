/**
 * The tab-close decision as data — the successor to `close-pane.ts`'s
 * pane-granularity decision, narrowed to TAB granularity now that tabs are
 * per-pane (`pu/pane-tabs`). The rule worth pinning is the same server-trust
 * discipline the old module had: never act on an unverified listing, and
 * never pre-guess "this ends the session" — always attempt the scoped close
 * and let the server's own last-listing 409 be the authority (the caller's
 * existing fallback turns that into the end-session confirm).
 *
 * What's GONE versus `close-pane.ts`, deliberately: the old `rebind-pane`
 * case existed because a non-chat pane (picker/terminal) had nothing of its
 * own to close and might need to "borrow" some OTHER pane's orphaned open
 * listing so the grid's last pane never vanished pointing at nothing. With
 * per-pane tabs, that scenario doesn't arise here — a pane's own tab list
 * (via `pane-reducer.ts`'s own `closeTab`) already falls back to ITS other
 * remaining tabs or its own picker; it never needs another pane's business.
 * Only actual chat panes have tabs, so a picker/terminal/mid-mint pane never
 * calls this decision at all — plain `closePane` (a pure layout removal)
 * covers it, same as it always has.
 */
import { describe, it, expect } from 'vitest';
import { decideCloseTab, type SessionConversationSummary } from '../close-pane-tab';

const listing = (
  conversationId: string,
  agentPageId: string | null = null,
  lastMessageAt: string | null = null,
): SessionConversationSummary => ({ conversationId, agentPageId, lastMessageAt });

describe('decideCloseTab', () => {
  describe('a duplicate view (the same conversation open as a tab in another pane)', () => {
    it('closes as layout-only — the OTHER pane keeps its own tab', () => {
      expect(
        decideCloseTab({
          allTabs: [
            { paneId: 'p1', targetId: 'conv-1' },
            { paneId: 'p2', targetId: 'conv-1' },
          ],
          paneId: 'p1',
          conversationId: 'conv-1',
          activeConversations: [listing('conv-1')],
        }),
      ).toEqual({ action: 'close-tab' });
    });

    it('is decided by grid layout alone — never even consults an unresolved listing', () => {
      expect(
        decideCloseTab({
          allTabs: [
            { paneId: 'p1', targetId: 'conv-1' },
            { paneId: 'p2', targetId: 'conv-1' },
          ],
          paneId: 'p1',
          conversationId: 'conv-1',
          activeConversations: null,
        }),
      ).toEqual({ action: 'close-tab' });
    });
  });

  describe('the listing has not loaded, or no longer lists this conversation', () => {
    it('given a null (unloaded) listing and no duplicate elsewhere, should never act on the unverified state', () => {
      // Genuinely unknown (never resolved, or the fetch failed) is NOT the
      // same fact as "resolved and confirmed not open" (the next test) — a
      // local-only close here would leave the conversation's actual listing
      // open server-side with no tab left to retry the close from.
      expect(
        decideCloseTab({
          allTabs: [{ paneId: 'p1', targetId: 'conv-1' }],
          paneId: 'p1',
          conversationId: 'conv-1',
          activeConversations: null,
        }),
      ).toEqual({ action: 'noop' });
    });

    it('given the conversation absent from a loaded listing (closed elsewhere), should drop the stale tab locally', () => {
      // Nothing server-side left to DELETE — someone else already closed it.
      expect(
        decideCloseTab({
          allTabs: [{ paneId: 'p1', targetId: 'conv-1' }],
          paneId: 'p1',
          conversationId: 'conv-1',
          activeConversations: [listing('conv-other')],
        }),
      ).toEqual({ action: 'close-tab' });
    });
  });

  describe('the sole surface addressing an open-listed conversation', () => {
    it('attempts the scoped close when other listings exist elsewhere in the session', () => {
      expect(
        decideCloseTab({
          allTabs: [{ paneId: 'p1', targetId: 'conv-1' }],
          paneId: 'p1',
          conversationId: 'conv-1',
          activeConversations: [listing('conv-1'), listing('conv-2')],
        }),
      ).toEqual({ action: 'close-conversation', conversationId: 'conv-1' });
    });

    it('still attempts the scoped close (never pre-guesses end-session) when it is the session\'s only open listing', () => {
      // Mirrors the old module's server-trust discipline: a resolved client
      // snapshot showing no OTHER listings can still be STALE. The caller's
      // existing 409 handling is what turns this into the end-session
      // confirm — this decision itself never short-circuits to it.
      expect(
        decideCloseTab({
          allTabs: [{ paneId: 'p1', targetId: 'conv-1' }],
          paneId: 'p1',
          conversationId: 'conv-1',
          activeConversations: [listing('conv-1')],
        }),
      ).toEqual({ action: 'close-conversation', conversationId: 'conv-1' });
    });

    it('attempts the scoped close even when OTHER panes exist in the grid, as long as none show this same conversation', () => {
      expect(
        decideCloseTab({
          allTabs: [
            { paneId: 'p1', targetId: 'conv-1' },
            { paneId: 'p2', targetId: 'conv-2' },
          ],
          paneId: 'p1',
          conversationId: 'conv-1',
          activeConversations: [listing('conv-1'), listing('conv-2')],
        }),
      ).toEqual({ action: 'close-conversation', conversationId: 'conv-1' });
    });
  });
});
