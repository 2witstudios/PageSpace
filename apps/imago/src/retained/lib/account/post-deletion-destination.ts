/**
 * Where the browser goes once an account deletion is queued: always the in-app
 * `/auth/account-deleted` page, never `/`. In the iOS app `/` is the marketing
 * site (with its pricing nav) inside the WebView, on the very path App Review
 * walks when it deletes a test account (Guideline 3.1.1). An Apple user
 * PageSpace could not disconnect from Sign in with Apple also gets the steps to
 * do it themselves (Guideline 5.1.1(v), Apple TN3194).
 */
export function postDeletionDestination(appleSignIn: string | undefined): string {
  return appleSignIn === 'manual' ? '/auth/account-deleted?appleSignIn=manual' : '/auth/account-deleted';
}
