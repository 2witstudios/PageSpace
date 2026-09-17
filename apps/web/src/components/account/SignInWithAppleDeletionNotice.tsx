import { Alert, AlertDescription } from "@/components/ui/alert";
import { Info } from "lucide-react";

/** What account deletion does about Sign in with Apple — from GET /api/account/apple-sign-in. */
export type AppleSignInRevocation = "automatic" | "manual" | "none";

/**
 * How a user removes PageSpace from Sign in with Apple themselves (App Store
 * Guideline 5.1.1(v), Apple TN3194) when PageSpace holds no revocable token for
 * them — they signed in before tokens were kept, or revocation failed.
 */
export function StopUsingSignInWithAppleSteps() {
  return (
    <ul className="list-disc list-inside text-sm space-y-1 ml-2">
      <li>
        On iPhone or iPad: open Settings → your name → Sign-In &amp; Security → Sign in with Apple, choose PageSpace, then tap
        Stop Using.
      </li>
      <li>
        On the web: sign in at{" "}
        <a href="https://account.apple.com" target="_blank" rel="noopener noreferrer" className="underline">
          account.apple.com
        </a>
        , open Sign-In and Security → Sign in with Apple, choose PageSpace, then choose Stop Using.
      </li>
    </ul>
  );
}

export function SignInWithAppleDeletionNotice({ revocation }: { revocation: AppleSignInRevocation }) {
  if (revocation === "none") return null;

  return (
    <Alert>
      <Info className="h-4 w-4" />
      <AlertDescription>
        {revocation === "automatic" ? (
          <p className="text-sm">We&apos;ll also disconnect PageSpace from Sign in with Apple.</p>
        ) : (
          <>
            <p className="text-sm mb-2">
              You signed in with Apple. After deleting your account, remove PageSpace from Sign in with Apple yourself:
            </p>
            <StopUsingSignInWithAppleSteps />
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}
