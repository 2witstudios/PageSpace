"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/retained/hooks/useAuth";
import { useRouter, retainedRouterHref } from "@/retained-adapters/navigation";
import useSWR from "swr";
import { Button } from "@/retained/components/ui/button";
import { Input } from "@/retained/components/ui/input";
import { Label } from "@/retained/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/retained/components/ui/avatar";
import { Alert, AlertDescription } from "@/retained/components/ui/alert";
import { toast } from "sonner";
import { User, Mail, Loader2, X, CheckCircle2, Download, Clock, Upload } from "lucide-react";
import { Badge } from "@/retained/components/ui/badge";
import { patch, post, del, fetchWithAuth } from '@/retained/lib/auth/auth-fetch';
import { useAuthStore } from "@/retained/stores/useAuthStore";
import { DeleteAccountDialog } from "@/retained/components/dialogs/DeleteAccountDialog";
import type { AppleSignInRevocation } from "@/retained/components/account/SignInWithAppleDeletionNotice";
import { postDeletionDestination } from "@/retained/lib/account/post-deletion-destination";
import { DriveOwnershipDialog } from "@/retained/components/dialogs/DriveOwnershipDialog";
import { ImageCropperDialog } from "@/retained/components/dialogs/ImageCropperDialog";
import { DeviceList } from "@/retained/components/devices/DeviceList";
import { RevokeAllDevicesDialog } from "@/retained/components/devices/RevokeAllDevicesDialog";
import { ConnectedAppsList } from "@/retained/components/oauth-grants/ConnectedAppsList";
import { useDevices } from "@/retained/hooks/useDevices";
import { PasskeyManager } from "@/retained/components/settings/PasskeyManager";
import { SettingsScreen, SettingsSection } from "@/ui/settings/settings-screen/settings-screen";


const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

interface Admin {
  id: string;
  name: string;
  email: string;
}

interface MultiMemberDrive {
  id: string;
  name: string;
  memberCount: number;
  admins: Admin[];
}

export default function AccountPage() {
  const { user, isLoading: authLoading, mutate } = useAuth();
  const router = useRouter();

  // Fetch email verification status
  const { data: accountData, error: accountDataError, isLoading: accountDataLoading } = useSWR<{ emailVerified: Date | null }>(
    user ? '/api/account/verification-status' : null,
    fetcher
  );

  // Profile form state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  // Avatar state
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [cropperOpen, setCropperOpen] = useState(false);
  const [cropperImageSrc, setCropperImageSrc] = useState<string | null>(null);

  // Email verification state
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [verificationEmailSent, setVerificationEmailSent] = useState(false);

  // Delete account state
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [isOwnershipDialogOpen, setIsOwnershipDialogOpen] = useState(false);
  const [multiMemberDrives, setMultiMemberDrives] = useState<MultiMemberDrive[]>([]);
  const [soloDrivesCount, setSoloDrivesCount] = useState(0);
  const [appleSignInRevocation, setAppleSignInRevocation] = useState<AppleSignInRevocation | undefined>(undefined);

  // Data export state
  const [isExporting, setIsExporting] = useState(false);
  const [exportCooldown, setExportCooldown] = useState<string | null>(null);

  // Devices state
  const { devices, refetch: refetchDevices } = useDevices();
  const [isRevokeAllDialogOpen, setIsRevokeAllDialogOpen] = useState(false);

  const uploadAvatarFile = async (file: File): Promise<void> => {
    const formData = new FormData();
    formData.append('file', file);

    // Use fetchWithAuth directly - post() helper sets Content-Type: application/json
    // which breaks FormData uploads. fetchWithAuth lets browser set correct boundary.
    const response = await fetchWithAuth('/api/account/avatar', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const data: unknown = await response.json().catch(() => ({}));
      const errorMessage =
        data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
          ? data.error
          : 'Failed to upload avatar';
      throw new Error(errorMessage);
    }

    const data: unknown = await response.json().catch(() => ({}));
    const avatarUrl =
      data && typeof data === 'object' && 'avatarUrl' in data && typeof data.avatarUrl === 'string'
        ? data.avatarUrl
        : null;

    if (avatarUrl) {
      setAvatarPreview(avatarUrl);
    }
  };

  // Load user data into form
  useEffect(() => {
    if (user) {
      setName(user.name || "");
      setEmail(user.email || "");
      if (user.image) {
        setAvatarPreview(user.image);
      }
    }
  }, [user]);

  // Redirect if not authenticated — except while deleting the account, which nulls
  // `user` on purpose (endSession) and then hard-navigates to the marketing home.
  // Without this guard that deliberate exit races with a client push to /auth/signin,
  // flashing the sign-in page at the user for a second on their way out.
  useEffect(() => {
    if (!authLoading && !user && !isDeletingAccount) {
      router.push("/auth/signin");
    }
  }, [authLoading, user, isDeletingAccount, router]);

  const handleProfileUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    const pendingAvatarFile = avatarFile;
    setIsSavingProfile(true);
    if (pendingAvatarFile) {
      setIsUploadingAvatar(true);
    }

    try {
      await patch("/api/account", { name, email });

      if (pendingAvatarFile) {
        await uploadAvatarFile(pendingAvatarFile);
        setAvatarFile(null);
      }
    } catch (error) {
      console.error("Profile update error:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update profile");
    } finally {
      mutate?.();
      setIsUploadingAvatar(false);
      setIsSavingProfile(false);
    }
  };

  const handleAvatarSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }

    // Validate file size (5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be less than 5MB');
      return;
    }

    // Create preview and open cropper
    const reader = new FileReader();
    reader.onloadend = () => {
      setCropperImageSrc(reader.result as string);
      setCropperOpen(true);
    };
    reader.readAsDataURL(file);

    // Reset file input so same file can be selected again
    e.target.value = '';
  };

  const handleCropComplete = (croppedBlob: Blob) => {
    // Create a File from the blob for upload
    const croppedFile = new File([croppedBlob], 'avatar.png', { type: 'image/png' });
    setAvatarFile(croppedFile);

    // Create preview from the cropped blob
    const previewUrl = URL.createObjectURL(croppedBlob);
    setAvatarPreview(previewUrl);
  };

  const handleAvatarUpload = async () => {
    if (!avatarFile) return;

    setIsUploadingAvatar(true);

    try {
      await uploadAvatarFile(avatarFile);
      setAvatarFile(null);

      // Refresh user data to get new avatar URL
      if (mutate) {
        await mutate();
      }
    } catch (error) {
      console.error('Avatar upload error:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to upload avatar');
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const handleAvatarDelete = async () => {
    setIsUploadingAvatar(true);

    try {
      await del('/api/account/avatar');

      setAvatarPreview(null);
      setAvatarFile(null);

      // Refresh user data
      if (mutate) {
        await mutate();
      }
    } catch (error) {
      console.error('Avatar deletion error:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to delete avatar');
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const handleResendVerification = async () => {
    setIsResendingVerification(true);
    try {
      const data = await post<{ message: string }>("/api/auth/resend-verification");

      setVerificationEmailSent(true);
      toast.success(data.message || "Verification email sent successfully. Please check your inbox.");
    } catch (error) {
      console.error("Resend verification error:", error);
      toast.error(error instanceof Error ? error.message : "Failed to send verification email");
    } finally {
      setIsResendingVerification(false);
    }
  };

  const handleDataExport = async () => {
    setIsExporting(true);
    try {
      const response = await fetchWithAuth('/api/account/export');

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '0', 10);
        const hours = Math.floor(retryAfter / 3600);
        const minutes = Math.ceil((retryAfter % 3600) / 60);
        const parts: string[] = [];
        if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
        if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
        const timeStr = parts.join(' and ') || 'a few moments';
        setExportCooldown(timeStr);
        toast.error('Export limit reached. Please try again later.');
        return;
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to export data');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pagespace-data-export-${new Date().toISOString().split('T')[0]}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setExportCooldown(null);
      toast.success('Your data export has been downloaded.');
    } catch (error) {
      console.error('Data export error:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to export data');
    } finally {
      setIsExporting(false);
    }
  };

  const handleInitiateAccountDeletion = async () => {
    // Sign in with Apple status for the dialog's notice (Guideline 5.1.1(v)).
    // Best-effort: it must never stand in the way of deleting the account.
    // Cleared first so a reopened dialog never shows the previous answer.
    setAppleSignInRevocation(undefined);
    void fetchWithAuth("/api/account/apple-sign-in")
      .then(async (response) => {
        if (!response.ok) {
          setAppleSignInRevocation(undefined);
          return;
        }
        const status = (await response.json()) as { revocation?: AppleSignInRevocation };
        setAppleSignInRevocation(status.revocation);
      })
      .catch(() => setAppleSignInRevocation(undefined));

    try {
      // Fetch drives status
      const response = await fetchWithAuth("/api/account/drives-status");
      if (!response.ok) {
        throw new Error("Failed to fetch drives status");
      }

      const data = await response.json();
      setSoloDrivesCount(data.soloDrives.length);
      setMultiMemberDrives(data.multiMemberDrives);

      // If there are multi-member drives, show ownership dialog
      if (data.multiMemberDrives.length > 0) {
        setIsOwnershipDialogOpen(true);
      } else {
        // No multi-member drives, proceed directly to deletion confirmation
        setIsDeleteDialogOpen(true);
      }
    } catch (error) {
      console.error("Error checking drives:", error);
      toast.error("Failed to check drive ownership status");
    }
  };

  const handleAllDrivesHandled = () => {
    setIsOwnershipDialogOpen(false);
    setMultiMemberDrives([]);
    setIsDeleteDialogOpen(true);
  };

  const handleDeleteAccount = async (emailConfirmation: string) => {
    setIsDeletingAccount(true);
    try {
      const result = await del<{ appleSignIn?: string }>("/api/account", { emailConfirmation });

      // Tear down the session before leaving: the account is gone, so the persisted
      // auth store and the token-refresh poller must not survive the navigation.
      useAuthStore.getState().endSession();

      // Deliberately a HARD navigation, so nothing from the ended session (stores,
      // SWR caches, the refresh poller) survives into the next page. The target is
      // the public in-app /auth/account-deleted page, never `/`: that is the
      // marketing site, which inside the iOS shell would put its pricing nav on the
      // path App Review walks (Guideline 3.1.1). An Apple user PageSpace could not
      // disconnect also sees the "Stop Using Sign in with Apple" steps there (TN3194).
      setTimeout(() => {
        window.location.href = retainedRouterHref(postDeletionDestination(result?.appleSignIn), window.location.origin);
      }, 1000);
    } catch (error) {
      console.error("Account deletion error:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to delete account";
      toast.error(errorMessage);
      setIsDeletingAccount(false);
      setIsDeleteDialogOpen(false);
    }
  };

  if (authLoading || !user) {
    return (
      <div className="container mx-auto py-10 px-10 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <SettingsScreen title="Profile" lede="Your name, sign-in methods and devices.">
      {/* Identity: picture, name and email. */}
      <form onSubmit={handleProfileUpdate} className="flex flex-col gap-6" aria-label="Identity">
        <div className="flex items-center gap-6">
          <div className="relative">
            <Avatar className="h-20 w-20">
              <AvatarImage src={avatarPreview || user?.image || ""} />
              <AvatarFallback>
                <User className="h-10 w-10" />
              </AvatarFallback>
            </Avatar>
            {avatarPreview && (
              <Button
                type="button"
                size="icon"
                variant="destructive"
                className="absolute -top-2 -right-2 h-6 w-6 rounded-full"
                onClick={handleAvatarDelete}
                disabled={isUploadingAvatar}
                aria-label="Remove profile picture"
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Profile picture</span>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="file"
                accept="image/*"
                onChange={handleAvatarSelect}
                className="hidden"
                id="avatar-upload"
              />
              <Label
                htmlFor="avatar-upload"
                className="inline-flex h-9 cursor-pointer items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent"
              >
                <Upload className="mr-2 h-4 w-4" />
                Upload image
              </Label>
              {avatarPreview && (
                <Button type="button" variant="ghost" size="sm" onClick={handleAvatarDelete} disabled={isUploadingAvatar}>
                  Remove
                </Button>
              )}
              {avatarFile && (
                <Button
                  type="button"
                  size="sm"
                  onClick={handleAvatarUpload}
                  disabled={isUploadingAvatar}
                >
                  {isUploadingAvatar ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    'Upload'
                  )}
                </Button>
              )}
            </div>
            {avatarFile && (
              <p className="text-xs text-muted-foreground">Selected: {avatarFile.name}</p>
            )}
          </div>
        </div>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter your name"
              required
            />
          </div>

          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="email">Email</Label>
              {accountData?.emailVerified && (
                <Badge variant="default" className="bg-green-600">
                  <CheckCircle2 className="mr-1 h-3 w-3" />
                  Verified
                </Badge>
              )}
            </div>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email"
              required
            />
            {/* Unverified email: the classic resend stays as a conditional row. */}
            {!accountDataLoading && !accountDataError && accountData && !accountData.emailVerified && (
              verificationEmailSent ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  Verification email sent to <strong>{user.email}</strong>.
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm text-muted-foreground">Your email is not verified.</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleResendVerification}
                    disabled={isResendingVerification}
                  >
                    {isResendingVerification ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Sending...
                      </>
                    ) : (
                      <>
                        <Mail className="mr-2 h-4 w-4" />
                        Resend verification email
                      </>
                    )}
                  </Button>
                </div>
              )
            )}
          </div>
        </div>

        <div>
          <Button type="submit" disabled={isSavingProfile}>
            {isSavingProfile ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save profile"
            )}
          </Button>
        </div>
      </form>

      {/* Passkeys: the retained manager keeps its register, rename and remove logic. */}
      <SettingsSection title="Passkeys" description="Sign in with Touch ID, Face ID or a security key.">
        <PasskeyManager />
      </SettingsSection>

      {/* Signed-in devices. */}
      <SettingsSection
        title="Signed-in devices"
        description="Devices are signed out automatically after 90 days."
        actions={
          devices && devices.length > 1 ? (
            <Button variant="outline" size="sm" onClick={() => setIsRevokeAllDialogOpen(true)}>
              Revoke all others
            </Button>
          ) : undefined
        }
      >
        <DeviceList />
      </SettingsSection>

      {/* Connected apps. */}
      <SettingsSection
        title="Connected apps"
        description="Apps and CLIs authorized to act as you. Revoking takes effect immediately, even if the device is offline."
      >
        <ConnectedAppsList />
      </SettingsSection>

      {/* Account. */}
      <SettingsSection title="Account">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">ID</span>
          <span className="font-mono text-xs text-foreground">{user.id}</span>
        </div>
      </SettingsSection>

      {/* Your data. */}
      <SettingsSection
        title="Your data"
        description="ZIP of your profile, drives, pages, messages, files, AI conversations and activity."
      >
        {exportCooldown && (
          <Alert>
            <Clock className="h-4 w-4" />
            <AlertDescription>
              You can request another export in {exportCooldown}.
            </AlertDescription>
          </Alert>
        )}
        <div>
          <Button onClick={handleDataExport} disabled={isExporting}>
            {isExporting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Preparing export...
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                Download my data
              </>
            )}
          </Button>
        </div>
      </SettingsSection>

      {/* Delete account: opens the ownership check, then the confirmation. */}
      <SettingsSection title="Delete account" description="Permanent. Drives you share with others must be transferred first.">
        <div>
          <Button
            variant="link"
            className="h-auto p-0 text-status-danger"
            onClick={handleInitiateAccountDeletion}
            disabled={isDeletingAccount}
          >
            Delete account
          </Button>
        </div>
      </SettingsSection>

      {/* Drive Ownership Dialog */}
      {isOwnershipDialogOpen && (
        <DriveOwnershipDialog
          isOpen={isOwnershipDialogOpen}
          onClose={() => setIsOwnershipDialogOpen(false)}
          onAllDrivesHandled={handleAllDrivesHandled}
          multiMemberDrives={multiMemberDrives}
        />
      )}

      {/* Delete Account Dialog */}
      <DeleteAccountDialog
        isOpen={isDeleteDialogOpen}
        onClose={() => setIsDeleteDialogOpen(false)}
        onConfirm={handleDeleteAccount}
        userEmail={user.email || ""}
        isDeleting={isDeletingAccount}
        soloDrivesCount={soloDrivesCount}
        appleSignInRevocation={appleSignInRevocation}
      />

      {/* Revoke All Devices Dialog */}
      <RevokeAllDevicesDialog
        open={isRevokeAllDialogOpen}
        onOpenChange={setIsRevokeAllDialogOpen}
        onSuccess={() => {
          refetchDevices();
          setIsRevokeAllDialogOpen(false);
        }}
        deviceCount={devices?.length || 0}
      />

      {/* Image Cropper Dialog */}
      {cropperImageSrc && (
        <ImageCropperDialog
          open={cropperOpen}
          onOpenChange={setCropperOpen}
          imageSrc={cropperImageSrc}
          onCropComplete={handleCropComplete}
        />
      )}
    </SettingsScreen>
  );
}
