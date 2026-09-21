import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StopUsingSignInWithAppleSteps } from "@/components/account/SignInWithAppleDeletionNotice";

/**
 * Post-deletion landing page for every account deletion (the deletion itself is
 * already queued). When PageSpace could not disconnect itself from the user's
 * Sign in with Apple (Guideline 5.1.1(v), Apple TN3194) it also shows how to
 * finish that step.
 */
export function AccountDeletedView({ showAppleSignInSteps }: { showAppleSignInSteps: boolean }) {
  return (
    <div className="flex items-center justify-center min-h-screen bg-muted dark:bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl text-center">Your account is being deleted</CardTitle>
          <CardDescription className="text-center">
            You&apos;ve been signed out, and your data is being permanently removed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {showAppleSignInSteps && (
            <div className="space-y-2">
              <p className="text-sm font-medium">One more step: remove PageSpace from Sign in with Apple</p>
              <StopUsingSignInWithAppleSteps />
            </div>
          )}
          {/* Stays in the app: `/` is the marketing site, which the iOS shell must not land on. */}
          <Button asChild variant="outline" className="w-full">
            <Link href="/auth/signin">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
