import { describe, it, expect } from 'vitest';
import { postDeletionDestination } from '../post-deletion-destination';

describe('postDeletionDestination', () => {
  it('given Apple revocation needs the user, should land on the in-app page with the Stop Using steps', () => {
    expect(postDeletionDestination('manual')).toBe('/auth/account-deleted?appleSignIn=manual');
  });

  // In the iOS app `/` is the marketing site (with its pricing nav) inside the
  // WebView — on the exact path App Review walks (Guideline 3.1.1).
  it.each(['revoked', 'none', undefined, 'unexpected'])(
    'given %s, should go to the in-app account-deleted page, never the marketing home',
    (outcome) => {
      expect(postDeletionDestination(outcome)).toBe('/auth/account-deleted');
    },
  );
});
