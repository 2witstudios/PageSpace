"use client";

import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { post } from '@/lib/auth-fetch';

export default function AuthButtons() {
  const { isAuthenticated, user } = useAuth();
  const router = useRouter();

  const handleSignOut = async () => {
    await post('/api/auth/logout');
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