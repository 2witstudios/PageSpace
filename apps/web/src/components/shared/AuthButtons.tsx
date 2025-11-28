"use client";

import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { post } from '@/lib/auth/auth-fetch';

export default function AuthButtons() {
  const { isAuthenticated, user } = useAuth();
  const router = useRouter();

  const handleSignOut = async () => {
    const isDesktop = typeof window !== 'undefined' && window.electron?.isDesktop;
    let body = {};

    if (isDesktop && window.electron) {
      const deviceInfo = await window.electron.auth.getDeviceInfo();
      body = {
        deviceId: deviceInfo.deviceId,
        platform: 'desktop' as const,
      };
    }

    await post('/api/auth/logout', body);
    router.push('/auth/signin');
  };

  if (isAuthenticated && user) {
    return (
      <>
        <Link href="/dashboard">
          <Button variant="outline">Dashboard</Button>
        </Link>
        <Button onClick={handleSignOut}>Sign Out</Button>
      </>
    );
  }

  return (
    <>
      <Link
        className="text-sm font-medium hover:underline underline-offset-4"
        href="/auth/signin"
      >
        Login
      </Link>
      <Link
        className="text-sm font-medium hover:underline underline-offset-4"
        href="/auth/signup"
      >
        Sign Up
      </Link>
    </>
  );
}