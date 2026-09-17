/**
 * Where the browser goes once an account deletion is queued. `/` is the
 * marketing home; an Apple user PageSpace could not disconnect from Sign in with
 * Apple goes to a web-app page that tells them how to do it themselves
 * (Guideline 5.1.1(v), Apple TN3194).
 */
export function postDeletionDestination(appleSignIn: string | undefined): string {
  return appleSignIn === 'manual' ? '/auth/account-deleted?appleSignIn=manual' : '/';
}
