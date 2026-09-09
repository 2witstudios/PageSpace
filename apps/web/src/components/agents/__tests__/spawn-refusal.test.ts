/**
 * The spawn-refusal classification — the pure decision behind the page's
 * fallback to a plain conversation. What matters: a QUOTA refusal (429) is the
 * one the user must HEAR about (they hold the capability and merely ran out of
 * allowance — silence reads as a permissions problem), while every other
 * refusal is the by-design silent degrade ("no workspace for you" is never
 * "no conversation").
 */
import { describe, it, expect } from 'vitest';

import { classifySpawnRefusal, claimConflictWorkspaceId } from '../spawn-refusal';

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

/**
 * The other half of a claim refusal: a 409 that names the workspace already
 * holding the conversation is not a degrade at all — it is the answer, and the
 * caller opens that workspace instead of leaving the Agents surface.
 */
// A REAL cuid2, because `claimConflictWorkspaceId` validates the shape —
// `agentWorkspaces.id` is `$defaultFn(createId)` everywhere, so a fixture that
// is not one would be testing a value the server cannot send.
const WORKSPACE_ID = 'qbiohdrz7895nz87fpw8w0h5';

describe('claimConflictWorkspaceId', () => {
  it("names the workspace a 409 body carries", () => {
    expect(
      claimConflictWorkspaceId(409, {
        error: 'That conversation already belongs to a session',
        workspaceId: WORKSPACE_ID,
      }),
    ).toBe(WORKSPACE_ID);
  });

  it('ignores a 409 that names no workspace — the type:\'client\' refusal has none to give', () => {
    expect(claimConflictWorkspaceId(409, { error: 'That conversation is not available' })).toBeNull();
  });

  it('never reads a workspace out of any other status, however the body looks', () => {
    // A 403/429/500 body is a refusal to degrade from, not a redirect. Reading
    // an id out of one would silently select into a workspace the server never
    // said was there.
    expect(claimConflictWorkspaceId(403, { workspaceId: WORKSPACE_ID })).toBeNull();
    expect(claimConflictWorkspaceId(429, { workspaceId: WORKSPACE_ID })).toBeNull();
    expect(claimConflictWorkspaceId(undefined, { workspaceId: WORKSPACE_ID })).toBeNull();
  });

  it('treats a body of any unexpected shape as naming nothing', () => {
    // Straight off the wire and therefore unknown until proven — the same
    // discipline whose absence caused the `sessionId`/`workspaceId` mismatch.
    expect(claimConflictWorkspaceId(409, undefined)).toBeNull();
    expect(claimConflictWorkspaceId(409, null)).toBeNull();
    expect(claimConflictWorkspaceId(409, 'That conversation already belongs to a session')).toBeNull();
    expect(claimConflictWorkspaceId(409, { workspaceId: 42 })).toBeNull();
    expect(claimConflictWorkspaceId(409, { workspaceId: '' })).toBeNull();
  });

  it('refuses a nonempty id that is not a real workspace id', () => {
    // Nonempty is not enough: this id would be selected into the surface store
    // and written to the URL, so a value no `agentWorkspaces.id` could ever
    // hold is worth refusing outright rather than opening a junk workspace.
    expect(claimConflictWorkspaceId(409, { workspaceId: 'not-a-workspace-id' })).toBeNull();
    expect(claimConflictWorkspaceId(409, { workspaceId: `  ${WORKSPACE_ID}  ` })).toBeNull();
    expect(claimConflictWorkspaceId(409, { workspaceId: `${WORKSPACE_ID}/../other` })).toBeNull();
  });
});
