"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { User, Mail, Calendar, AlertTriangle, Loader2, ArrowLeft, Upload, X, CheckCircle2, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { patch, post, del } from '@/lib/auth-fetch';

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function AccountPage() {
  const { user, isLoading: authLoading, mutate } = useAuth();
  const router = useRouter();

  // Fetch email verification status
  const { data: accountData } = useSWR<{ emailVerified: Date | null }>(
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

  // Password form state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  // Email verification state
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [verificationEmailSent, setVerificationEmailSent] = useState(false);

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

  // Redirect if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/auth/signin");
    }
  }, [authLoading, user, router]);

  const handleProfileUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingProfile(true);

    try {
      await patch("/api/account", { name, email });

      if (mutate) {
        await mutate(); // Refresh user data
      }
      toast.success("Profile updated successfully");
    } catch (error) {
      console.error("Profile update error:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update profile");
    } finally {
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

    setAvatarFile(file);

    // Create preview
    const reader = new FileReader();
    reader.onloadend = () => {
      setAvatarPreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleAvatarUpload = async () => {
    if (!avatarFile) return;

    setIsUploadingAvatar(true);
    const formData = new FormData();
    formData.append('file', avatarFile);

    try {
      await post('/api/account/avatar', formData);

      toast.success('Avatar uploaded successfully');
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

      toast.success('Avatar deleted successfully');
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

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error("New passwords don't match");
      return;
    }

    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters long");
      return;
    }

    setIsSavingPassword(true);

    try {
      await post("/api/account/password", {
        currentPassword,
        newPassword,
      });

      toast.success("Password changed successfully");
      // Clear password fields
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      console.error("Password change error:", error);
      toast.error(error instanceof Error ? error.message : "Failed to change password");
    } finally {
      setIsSavingPassword(false);
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

  if (authLoading || !user) {
    return (
      <div className="container mx-auto py-10 px-10 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  const memberSince = user.id ? new Date().toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  }) : "Unknown";

  return (
    <div className="container mx-auto py-10 px-10 max-w-4xl">
      <div className="mb-8">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/settings')}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Settings
        </Button>
        <h1 className="text-3xl font-bold mb-2">Account Settings</h1>
        <p className="text-muted-foreground">
          Manage your account information and security settings
        </p>
      </div>

      {/* Profile Section */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Profile Information</CardTitle>
          <CardDescription>Update your personal information</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleProfileUpdate} className="space-y-4">
            <div className="flex items-center gap-6 mb-6">
              <div className="relative">
                <Avatar className="h-20 w-20">
                  <AvatarImage src={avatarPreview || user?.image || ""} />
                  <AvatarFallback>
                    <User className="h-10 w-10" />
                  </AvatarFallback>
                </Avatar>
                {avatarPreview && (
                  <Button
                    size="icon"
                    variant="destructive"
                    className="absolute -top-2 -right-2 h-6 w-6 rounded-full"
                    onClick={handleAvatarDelete}
                    disabled={isUploadingAvatar}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
              <div className="flex-1">
                <Label>Profile Picture</Label>
                <p className="text-sm text-muted-foreground mb-3">
                  Upload a profile picture to personalize your account
                </p>
                <div className="flex gap-2">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarSelect}
                    className="hidden"
                    id="avatar-upload"
                  />
                  <Label
                    htmlFor="avatar-upload"
                    className="cursor-pointer inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3"
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Choose File
                  </Label>
                  {avatarFile && (
                    <Button
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
                  <p className="text-xs text-muted-foreground mt-2">
                    Selected: {avatarFile.name}
                  </p>
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
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter your email"
                  required
                />
              </div>
            </div>

            <Button type="submit" disabled={isSavingProfile}>
              {isSavingProfile ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Email Verification Section */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Email Verification</CardTitle>
              <CardDescription>Verify your email to unlock all features</CardDescription>
            </div>
            {accountData?.emailVerified ? (
              <Badge variant="default" className="bg-green-600">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Verified
              </Badge>
            ) : (
              <Badge variant="destructive">
                <AlertCircle className="h-3 w-3 mr-1" />
                Unverified
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {accountData?.emailVerified ? (
            <Alert>
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <AlertDescription>
                Your email address has been verified.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <p className="mb-2">
                    Please verify your email address to unlock all features:
                  </p>
                  <ul className="list-disc list-inside text-sm space-y-1 ml-2">
                    <li>Send drive invitations</li>
                    <li>Send connection requests</li>
                    <li>Send direct messages</li>
                  </ul>
                </AlertDescription>
              </Alert>

              {verificationEmailSent ? (
                <Alert>
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <AlertDescription>
                    Verification email sent! Please check your inbox at <strong>{user.email}</strong>
                  </AlertDescription>
                </Alert>
              ) : (
                <div>
                  <p className="text-sm text-muted-foreground mb-3">
                    Didn&apos;t receive the verification email? Click the button below to send a new one to <strong>{user.email}</strong>
                  </p>
                  <Button
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
                        Resend Verification Email
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Security Section */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Security</CardTitle>
          <CardDescription>Manage your password and security settings</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePasswordChange} className="space-y-4">
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="current-password">Current Password</Label>
                <Input
                  id="current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="Enter current password"
                  required
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="new-password">New Password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Enter new password (min 8 characters)"
                  required
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="confirm-password">Confirm New Password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  required
                />
              </div>
            </div>

            <Button type="submit" disabled={isSavingPassword}>
              {isSavingPassword ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Changing Password...
                </>
              ) : (
                "Change Password"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Account Info */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Account Information</CardTitle>
          <CardDescription>View your account details</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Member since:</span>
            <span>{memberSince}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Mail className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Account ID:</span>
            <span className="font-mono text-xs">{user.id}</span>
          </div>
        </CardContent>
      </Card>

      {/* Danger Zone */}
      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
          <CardDescription>Irreversible actions for your account</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Account deletion is permanent and cannot be undone. This feature is coming soon.
            </AlertDescription>
          </Alert>
          <Button variant="destructive" className="mt-4" disabled>
            Delete Account (Coming Soon)
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}