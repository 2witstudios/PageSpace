import { describe, it, expect } from 'vitest';
import { postDeletionDestination } from '../post-deletion-destination';

describe('postDeletionDestination', () => {
  it('given Apple revocation needs the user, should land on the page with the Stop Using steps', () => {
    expect(postDeletionDestination('manual')).toBe('/auth/account-deleted?appleSignIn=manual');
  });

  it.each(['revoked', 'none', undefined, 'unexpected'])('given %s, should go home as before', (outcome) => {
    expect(postDeletionDestination(outcome)).toBe('/');
  });
});
