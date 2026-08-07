/**
 * The ONE page-conversation access decision, shared by `page-chat-turn` (which
 * appends turns) and the consult route (which reads history into the model
 * context). Two questions, both of which must pass: is it yours, and does it
 * belong to THIS page.
 *
 * The properties under test are the ones the type-blind version got wrong: a
 * global thread must not belong to every page, a client thread names its page
 * in `agentPageId` rather than `contextId`, and the legacy null-context
 * tolerance must be owner-scoped so a shared legacy row is not reachable from
 * any page a co-member can see.
 */
import { describe, it, expect } from 'vitest';
import {
  authorizePageConversation,
  type PageConversationFacts,
} from '../authorize-page-conversation';

const ME = 'user-me';
const THEM = 'user-them';
const PAGE = 'page-1';
const OTHER_PAGE = 'page-2';

const row = (over: Partial<PageConversationFacts> = {}): PageConversationFacts => ({
  userId: ME,
  type: 'page',
  contextId: PAGE,
  agentPageId: null,
  isShared: false,
  isActive: true,
  ...over,
});

const check = (facts: PageConversationFacts, userId = ME, pageId = PAGE) =>
  authorizePageConversation(facts, { userId, pageId });

describe('ownership', () => {
  it('allows the owner', () => {
    expect(check(row())).toEqual({ allowed: true });
  });

  it('allows a co-member on an explicitly shared conversation', () => {
    expect(check(row({ userId: THEM, isShared: true }))).toEqual({ allowed: true });
  });

  it('refuses someone else\'s unshared conversation', () => {
    const result = check(row({ userId: THEM }));
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toBe('not_yours');
  });

  it('treats a null isShared as not shared', () => {
    expect(check(row({ userId: THEM, isShared: null })).allowed).toBe(false);
  });
});

describe('which page a conversation belongs to', () => {
  it('a page thread belongs to the page named in contextId', () => {
    expect(check(row({ type: 'page', contextId: PAGE })).allowed).toBe(true);
    expect(check(row({ type: 'page', contextId: OTHER_PAGE })).allowed).toBe(false);
  });

  // A `type='global'` row ALWAYS has `contextId IS NULL` (the database enforces
  // it), so a null-tolerant test said every global conversation belongs to
  // every page — the bug that let a page-agent turn be appended to the
  // global-assistant transcript.
  it('a global thread belongs to NO page, even for its own owner', () => {
    const result = check(row({ type: 'global', contextId: null }));
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toBe('wrong_page');
  });

  // The mirror hole: a client thread's `contextId` is a DRIVE, so matching on
  // it was meaningless.
  it('a client thread belongs to the page named in agentPageId, never contextId', () => {
    expect(check(row({ type: 'client', contextId: PAGE, agentPageId: null })).allowed).toBe(false);
    expect(check(row({ type: 'client', contextId: 'drive-1', agentPageId: PAGE })).allowed).toBe(true);
  });

  it('an unknown type belongs to no page', () => {
    expect(check(row({ type: 'something-new', contextId: PAGE })).allowed).toBe(false);
  });
});

describe('the legacy null-context tolerance', () => {
  // `conversations_page_context_present_chk` shipped NOT VALID, so page rows
  // with a null contextId were grandfathered; their OWNERS must not be locked
  // out of their own history.
  it('lets the owner of a legacy null-context page row through', () => {
    expect(check(row({ type: 'page', contextId: null })).allowed).toBe(true);
  });

  // Without the owner scope, a legacy row marked shared would be reachable
  // from ANY page a co-member can see — the residual the scoping closes.
  it('does NOT extend to a co-member on a shared legacy row, from any page', () => {
    const legacyShared = row({ type: 'page', contextId: null, userId: THEM, isShared: true });
    expect(check(legacyShared).allowed).toBe(false);
    expect(check(legacyShared, ME, OTHER_PAGE).allowed).toBe(false);
  });
});

describe('history-deleted rows', () => {
  it('refuses the owner\'s own deactivated row, distinguishably', () => {
    const result = check(row({ isActive: false }));
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toBe('history_deleted');
  });

  // `history_deleted` on a row the caller cannot reach would be an existence
  // oracle: it reveals both that the id exists and what state it is in.
  it('refuses a FOREIGN deactivated row as not_yours, never history_deleted', () => {
    const result = check(row({ userId: THEM, isActive: false }));
    expect(result.allowed === false && result.reason).toBe('not_yours');
  });

  it('refuses a foreign deactivated row identically to a foreign live one', () => {
    expect(check(row({ userId: THEM, isActive: false }))).toEqual(check(row({ userId: THEM })));
  });

  // The refusal is `isActive === false`, not `!isActive`. A row that simply
  // does not carry the column — a partial projection, a legacy row — is live.
  // Reading it as falsiness 404s every such conversation, which is exactly what
  // happened when this logic was first extracted out of `page-chat-turn`.
  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('treats an %s isActive as live, not history-deleted', (_label, value) => {
    expect(check(row({ isActive: value as boolean | null | undefined }))).toEqual({ allowed: true });
  });
});

describe('the refusal detail', () => {
  it('carries the conversation type, without which a refusal is undiagnosable', () => {
    const result = check(row({ type: 'global', contextId: null }));
    expect(result.allowed === false && result.detail).toEqual({
      ownsIt: true,
      isSharedConversation: false,
      belongsToThisPage: false,
      conversationType: 'global',
    });
  });
});
