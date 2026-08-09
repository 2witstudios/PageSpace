/**
 * ONE RULE, AND IT MUST STAY ONE (review finding).
 *
 * `conversationPageId` is the row-level twin of `derivedPageId()`'s SQL CASE.
 * Six call sites used to re-spell that CASE by hand and three different answers
 * were in circulation: five dropped the `client` branch, one mapped `drive`
 * onto `agentPageId` where the SQL yields NULL.
 *
 * These cases are written against the CASE expression's own branches, so a
 * change to one rendering that is not made to the other fails here. The SQL
 * text itself is pinned in `unified-message-scope`'s suite; this file pins the
 * semantics both must share.
 */
import { describe, it, expect } from 'vitest';
import { conversationPageId } from '../conversation-page';

const PAGE = 'pg_agent';
const DRIVE = 'drv_1';

describe('conversationPageId', () => {
  it("takes contextId for type='page' — the in-app page chat", () => {
    expect(conversationPageId({ type: 'page', contextId: PAGE, agentPageId: null })).toBe(PAGE);
  });

  it("takes agentPageId for type='client' — the branch five call sites dropped", () => {
    // The API-managed threads `POST /api/v1/conversations` mints. Their
    // contextId is a DRIVE and is load-bearing there (a drive-scoped MCP token
    // is authorized against it), which is exactly why their page needs its own
    // column — and why reading contextId here would be actively wrong, not
    // merely incomplete.
    expect(conversationPageId({ type: 'client', contextId: DRIVE, agentPageId: PAGE })).toBe(PAGE);
  });

  it("yields null for type='global' — there is no page to name", () => {
    expect(conversationPageId({ type: 'global', contextId: null, agentPageId: null })).toBeNull();
  });

  it("yields null for type='drive', NOT its agentPageId — the third answer that was in circulation", () => {
    // `ai-undo-service` mapped this onto `agentPageId`. The SQL CASE has no
    // drive branch, so it yields NULL; a drive conversation's contextId is a
    // drive id and must never be handed to a page-scoped gate.
    expect(conversationPageId({ type: 'drive', contextId: DRIVE, agentPageId: PAGE })).toBeNull();
  });

  it('yields null for an unknown type rather than guessing a column', () => {
    expect(conversationPageId({ type: 'something_new', contextId: PAGE, agentPageId: PAGE })).toBeNull();
  });

  it('tolerates a missing conversation and missing columns', () => {
    // Callers hold rows from optional joins; a null page is the fail-quiet
    // answer the page-scoped routes already 404 on.
    expect(conversationPageId(null)).toBeNull();
    expect(conversationPageId(undefined)).toBeNull();
    expect(conversationPageId({ type: 'page', contextId: null })).toBeNull();
    expect(conversationPageId({ type: 'client', contextId: DRIVE })).toBeNull();
  });
});
