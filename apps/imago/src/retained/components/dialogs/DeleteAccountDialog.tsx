import { useState } from "react";
import useSWR from "swr";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/retained/components/ui/alert-dialog";
import { Input } from "@/retained/components/ui/input";
import { Label } from "@/retained/components/ui/label";
import { Alert, AlertDescription } from "@/retained/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import { SignInWithAppleDeletionNotice, type AppleSignInRevocation } from "@/retained/components/account/SignInWithAppleDeletionNotice";
import { ApiRequestError, fetchWithAuth } from "@/retained/lib/auth/auth-fetch";

/**
 * Whether Apple will charge the viewer again — GET /api/subscriptions/status `appStoreRenews`
 * (auto-renew on, renewal-capable), or an App Store-sold current plan. A failed request
 * throws: an unknown answer is never read as "no subscription".
 */
async function fetchAppStoreRenews([url]: readonly [string, "app-store-renews"]): Promise<boolean> {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch subscription status: ${response.status}`);
  const body: { billingProvider?: string | null; appStoreRenews?: boolean } = await response.json();
  return body.appStoreRenews === true || body.billingProvider === "apple";
}

/**
 * Account deletion cannot cancel a subscription Apple bills, so an App Store subscriber is
 * told where to cancel it before deleting (Imago has no StoreKit sheet to open).
 */
export const APP_STORE_DELETION_NOTICE =
  "Deleting your account does not cancel your App Store subscription. Cancel it in your App Store subscriptions first to stop being charged. On your iPhone or iPad: Settings › Apple ID › Subscriptions.";

/**
 * The organizations a DELETE /api/account refusal names as still owned by the viewer. Only the
 * orgs-enabled API sends this; any other error (or a body without the list) yields undefined.
 */
export function ownedOrganizationsFrom(error: unknown): readonly string[] | undefined {
  if (!(error instanceof ApiRequestError) || typeof error.body !== "object" || error.body === null) return undefined;
  const owned: unknown = (error.body as { ownedOrganizations?: unknown }).ownedOrganizations;
  if (!Array.isArray(owned) || !owned.every((name): name is string => typeof name === "string")) return undefined;
  return owned.length > 0 ? owned : undefined;
}

interface DeleteAccountDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (emailConfirmation: string) => void;
  userEmail: string;
  isDeleting: boolean;
  soloDrivesCount: number;
  /** Unknown (still loading, or the status request failed) renders no Apple notice. */
  appleSignInRevocation?: AppleSignInRevocation;
  /** Organizations the viewer still owns; a refusal from the server. Blocks confirming while present. */
  ownedOrganizations?: readonly string[];
}

export function DeleteAccountDialog({
  isOpen,
  onClose,
  onConfirm,
  userEmail,
  isDeleting,
  soloDrivesCount,
  appleSignInRevocation,
  ownedOrganizations,
}: DeleteAccountDialogProps) {
  const [emailConfirmation, setEmailConfirmation] = useState("");
  // A key of its own: this caches a boolean, not the status body other readers of the URL expect.
  const { data: appStoreRenews, error: appStoreStatusError } = useSWR(
    isOpen ? (["/api/subscriptions/status", "app-store-renews"] as const) : null,
    fetchAppStoreRenews,
    { revalidateOnFocus: false },
  );

  const isEmailMatch = emailConfirmation.trim().toLowerCase() === userEmail.toLowerCase();
  const isRefused = ownedOrganizations !== undefined && ownedOrganizations.length > 0;
  // Confirming waits for the App Store answer. If it cannot be had, the warning shows
  // anyway rather than blocking deletion on a billing read.
  const isAppStoreStatusPending = isOpen && appStoreRenews === undefined && appStoreStatusError === undefined;
  const showAppStoreNotice = appStoreRenews === true || appStoreStatusError !== undefined;

  const handleConfirm = () => {
    if (isEmailMatch && !isRefused && !isAppStoreStatusPending) {
      onConfirm(emailConfirmation);
    }
  };

  const handleClose = () => {
    if (!isDeleting) {
      setEmailConfirmation("");
      onClose();
    }
  };

  return (
    <AlertDialog open={isOpen} onOpenChange={handleClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Your Account?</AlertDialogTitle>
          <AlertDialogDescription>
            This action is permanent and cannot be undone. All your data will be permanently deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4">
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              <p className="font-semibold mb-2">Warning:</p>
              <ul className="list-disc list-inside text-sm space-y-1 ml-2">
                {soloDrivesCount > 0 && (
                  <li>{soloDrivesCount} drive{soloDrivesCount !== 1 ? 's' : ''} where you&apos;re the only member will be automatically deleted</li>
                )}
                <li>All your data, messages, and content will be permanently lost</li>
                <li>This action cannot be reversed</li>
              </ul>
            </AlertDescription>
          </Alert>

          {isRefused && (
            <Alert variant="destructive" role="status">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <p className="font-semibold mb-2">
                  Transfer ownership of your organizations or delete them before deleting your account
                </p>
                <ul className="list-disc list-inside text-sm space-y-1 ml-2">
                  {ownedOrganizations.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {showAppStoreNotice && (
            <Alert role="status" data-testid="app-store-deletion-notice">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{APP_STORE_DELETION_NOTICE}</AlertDescription>
            </Alert>
          )}

          {appleSignInRevocation && <SignInWithAppleDeletionNotice revocation={appleSignInRevocation} />}

          <div className="space-y-2">
            <Label htmlFor="email-confirmation">
              Type your email address <strong>{userEmail}</strong> to confirm:
            </Label>
            <Input
              id="email-confirmation"
              type="email"
              value={emailConfirmation}
              onChange={(e) => setEmailConfirmation(e.target.value)}
              placeholder="Enter your email address"
              disabled={isDeleting}
              autoComplete="off"
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={!isEmailMatch || isRefused || isDeleting || isAppStoreStatusPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? "Deleting Account..." : "Delete Account Permanently"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
