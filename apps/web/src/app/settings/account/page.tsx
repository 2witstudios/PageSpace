"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Loader2, User } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { SettingsPageLayout } from "@/components/settings/SettingsPageLayout";
import { ProfileSection } from "@/components/settings/ProfileSection";
import { EmailVerificationSection } from "@/components/settings/EmailVerificationSection";
import { SecuritySection } from "@/components/settings/SecuritySection";
import { DevicesSection } from "@/components/settings/DevicesSection";
import { AccountInfoSection } from "@/components/settings/AccountInfoSection";
import { DataPrivacySection } from "@/components/settings/DataPrivacySection";
import { DangerZoneSection } from "@/components/settings/DangerZoneSection";
import { useDevices } from "@/hooks/useDevices";

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
};

export default function AccountPage() {
  const { user, isLoading: authLoading, mutate } = useAuth();
  const router = useRouter();

  // Email verification status
  const { data: verificationData, error: verificationError, isLoading: verificationLoading } = useSWR<{ emailVerified: Date | null }>(
    user ? '/api/account/verification-status' : null,
    fetcher
  );

  // Account info (hasPassword)
  const { data: accountInfo, error: accountInfoError, isLoading: accountInfoLoading } = useSWR<{ hasPassword: boolean }>(
    user ? '/api/account' : null,
    fetcher
  );

  // Devices
  const { devices, refetch: refetchDevices } = useDevices();

  // Redirect if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/auth/signin");
    }
  }, [authLoading, user, router]);

  if (authLoading || !user) {
    return (
      <div className="container mx-auto py-10 px-10 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  const memberSince = new Date().toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  return (
    <SettingsPageLayout
      title="Account Settings"
      description="Manage your account information and security settings"
      icon={User}
      maxWidth="4xl"
    >
      <ProfileSection user={user} onUserUpdate={() => mutate?.()} />

      <EmailVerificationSection
        email={user.email || ""}
        emailVerified={verificationData?.emailVerified}
        isLoading={verificationLoading}
        error={verificationError}
      />

      <SecuritySection
        hasPassword={accountInfo?.hasPassword}
        isLoading={accountInfoLoading}
        error={accountInfoError}
      />

      <DevicesSection devices={devices} onRefetch={refetchDevices} />

      <AccountInfoSection userId={user.id} memberSince={memberSince} />

      <DataPrivacySection />

      <DangerZoneSection userEmail={user.email || ""} />
    </SettingsPageLayout>
  );
}
