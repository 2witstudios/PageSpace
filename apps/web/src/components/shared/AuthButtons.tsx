"use client";

import { useAuth } from "@/hooks/useAuth";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function AuthButtons() {
  const { isAuthenticated, user, actions } = useAuth();

  // Delegate to the shared logout action so sign-out runs the full client
  // teardown (device-context send for M9 server-side device-token revocation,
  // secure-storage/localStorage clear, store reset, redirect) in one place
  // instead of a parallel, less-complete copy.
  const handleSignOut = () => actions.logout();

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