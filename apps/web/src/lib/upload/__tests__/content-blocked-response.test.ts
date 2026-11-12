import { describe, it, expect } from 'vitest';
import { ContentBlockedError } from '@pagespace/lib/content-safety/policy';
import { contentBlockedResponseFor } from '../content-blocked-response';

const HASH = 'd'.repeat(64);

describe('contentBlockedResponseFor', () => {
  it('maps a ContentBlockedError to a neutral 422', async () => {
    const res = contentBlockedResponseFor(new ContentBlockedError(HASH));

    expect(res?.status).toBe(422);
    expect(await res?.json()).toEqual({ error: "This file can't be uploaded" });
  });

  it('never leaks the blocked hash', async () => {
    const res = contentBlockedResponseFor(new ContentBlockedError(HASH));

    expect(JSON.stringify(await res?.json())).not.toContain(HASH);
  });

  it('returns null for any other error, so the caller keeps its own handling', () => {
    expect(contentBlockedResponseFor(new Error('db down'))).toBeNull();
    expect(contentBlockedResponseFor('nope')).toBeNull();
    expect(contentBlockedResponseFor(undefined)).toBeNull();
  });
});
