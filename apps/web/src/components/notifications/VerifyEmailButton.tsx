'use client';

import { useAuthStore } from '@/stores/auth-store';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import Link from 'next/link';

export default function VerifyEmailButton() {
  const user = useAuthStore((state) => state.user);

  // Only show if user exists and email is not verified
  if (!user || user.emailVerified) {
    return null;
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/20"
      asChild
    >
      <Link href="/settings/account" className="flex items-center gap-1.5">
        <AlertCircle className="h-4 w-4" />
        <span className="hidden sm:inline text-xs font-medium">Verify Email</span>
      </Link>
    </Button>
  );
}
