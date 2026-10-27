/**
 * Pins the ONE shared-workspace listing redaction rule (issue #2262 finding
 * 6): the workspace owner sees everything in their own workspace; any other
 * viewer sees a title only for their own or deliberately-shared threads, and
 * the fixed `(private thread)` marker for everyone else's. The rule is a
 * product decision explicitly open to veto — this suite pins the MECHANISM
 * (one function, fail-closed) so an adjustment is one deliberate edit here
 * and there, never drift.
 */
import { describe, it, expect } from 'vitest';
import {
  PRIVATE_THREAD_REDACTION,
  redactConversationTitleForViewer,
} from '../redact-conversation-listing';

const OWNER = 'user-owner';
const MEMBER = 'user-member';
const OTHER_MEMBER = 'user-other';

function title(viewerId: string, conversation: { ownerId: string; isShared: boolean; title: string | null }) {
  return redactConversationTitleForViewer({
    viewerId,
    workspaceOwnerId: OWNER,
    conversation,
  });
}

describe('redactConversationTitleForViewer', () => {
  it('the workspace OWNER sees every title in their own workspace, unchanged — including other members\' private threads', () => {
    expect(title(OWNER, { ownerId: MEMBER, isShared: false, title: 'secret plans' })).toBe('secret plans');
    expect(title(OWNER, { ownerId: OWNER, isShared: false, title: 'my own' })).toBe('my own');
  });

  it('a member sees their OWN thread\'s title in a workspace they do not own', () => {
    expect(title(MEMBER, { ownerId: MEMBER, isShared: false, title: 'mine' })).toBe('mine');
  });

  it('a member sees a deliberately SHARED thread\'s title', () => {
    expect(title(MEMBER, { ownerId: OTHER_MEMBER, isShared: true, title: 'team notes' })).toBe('team notes');
  });

  it('a member sees the fixed redaction marker for another member\'s private thread — never the real title', () => {
    expect(title(MEMBER, { ownerId: OTHER_MEMBER, isShared: false, title: 'their secret' })).toBe(
      PRIVATE_THREAD_REDACTION,
    );
    expect(title(MEMBER, { ownerId: OWNER, isShared: false, title: 'owner secret' })).toBe(
      PRIVATE_THREAD_REDACTION,
    );
  });

  it('a null title passes through where the viewer may see it, and still redacts to the marker where not', () => {
    expect(title(MEMBER, { ownerId: MEMBER, isShared: false, title: null })).toBeNull();
    expect(title(MEMBER, { ownerId: OTHER_MEMBER, isShared: false, title: null })).toBe(PRIVATE_THREAD_REDACTION);
  });

  it('fails CLOSED on a degenerate empty viewer id — an empty id matches no owner, so nothing private leaks', () => {
    expect(title('', { ownerId: '', isShared: false, title: 'x' })).toBe(PRIVATE_THREAD_REDACTION);
    expect(
      redactConversationTitleForViewer({
        viewerId: '',
        workspaceOwnerId: '',
        conversation: { ownerId: 'someone', isShared: false, title: 'x' },
      }),
    ).toBe(PRIVATE_THREAD_REDACTION);
  });
});
