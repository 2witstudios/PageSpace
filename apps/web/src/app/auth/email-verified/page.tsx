"use client";

import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { AuthStatusCard } from "@/components/auth/AuthStatusCard";
import { authHomePath } from "@/lib/imago/auth-home";
import { isV3AuthEnabled } from "@/lib/imago/v3-auth-enabled";

export default function EmailVerified() {
  if (isV3AuthEnabled()) {
    return (
      <AuthLayout>
        <AuthStatusCard
          icon={<CheckCircle2 className="h-5 w-5" />}
          title="Email Verified!"
          action={
            <Button asChild className="w-full">
              <Link href={authHomePath()}>Go to Dashboard</Link>
            </Button>
          }
        >
          <p>Your email address has been successfully verified.</p>
          <p>You can now access all features of PageSpace.</p>
        </AuthStatusCard>
      </AuthLayout>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-muted dark:bg-background">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex justify-center mb-4">
            <div className="rounded-full bg-green-100 dark:bg-green-900 p-3">
              <svg
                className="w-12 h-12 text-green-600 dark:text-green-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
          </div>
          <CardTitle className="text-2xl text-center">Email Verified!</CardTitle>
          <CardDescription className="text-center">
            Your email address has been successfully verified.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <p className="text-center text-sm text-muted-foreground">
              You can now access all features of PageSpace.
            </p>
            <Button asChild className="w-full">
              <Link href={authHomePath()}>Go to Dashboard</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
