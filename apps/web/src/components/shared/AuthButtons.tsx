"use client";

import { useAuth } from "@/hooks/useAuth";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { post } from '@/lib/auth/auth-fetch';

export default function AuthButtons() {
  const { isAuthenticated, user } = useAuth();
  const router = useRouter();

  const handleSignOut = async () => {
    // SECURITY (M9): send device context so the server revokes the long-lived
    // device token, not just the session. Prefer the token value (works on any
    // platform); deviceId+platform is the fallback. Never block sign-out on it.
    let body: Record<string, unknown> = {};
    try {
      const { getPlatformStorage } = await import('@/lib/auth/platform-storage');
      const storage = getPlatformStorage();
      const stored = await storage.getStoredSession();
      body = {
        deviceToken: stored?.deviceToken ?? undefined,
        deviceId: stored?.deviceId ?? undefined,
        platform: storage.platform,
      };
    } catch (err) {
      console.error('Failed to read device context for sign-out', err);
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