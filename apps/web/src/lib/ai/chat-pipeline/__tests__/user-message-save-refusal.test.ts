import { describe, it, expect } from 'vitest';
import { ContentBlockedError } from '@pagespace/lib/content-safety/policy';
import { ConversationHistoryDeletedError } from '@/lib/repositories/resolve-or-create-conversation';
import { userMessageSaveRefusal } from '../user-message-save-refusal';

describe('userMessageSaveRefusal', () => {
  it('maps a deleted conversation to 404', async () => {
    const res = userMessageSaveRefusal(new ConversationHistoryDeletedError());

    expect(res?.status).toBe(404);
    expect(await res?.json()).toEqual({ error: 'Conversation not found' });
  });

  it('maps a blocklisted attachment to the neutral upload refusal', async () => {
    const res = userMessageSaveRefusal(new ContentBlockedError('e'.repeat(64)));

    expect(res?.status).toBe(422);
    expect(await res?.json()).toEqual({ error: "This file can't be uploaded" });
  });

  it('returns null for any other failure, leaving the turn its own 500', () => {
    expect(userMessageSaveRefusal(new Error('db down'))).toBeNull();
  });
});
