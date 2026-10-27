'use client';

import { Alert, AlertDescription, AlertTitle } from '@/retained/components/ui/alert';
import { Button } from '@/retained/components/ui/button';
import { useRouter } from '@/retained-adapters/navigation';
import { AlertCircle } from 'lucide-react';

interface VerificationRequiredAlertProps {
  onDismiss?: () => void;
}

export function VerificationRequiredAlert({ onDismiss }: VerificationRequiredAlertProps) {
  const router = useRouter();

  const handleGoToSettings = () => {
    router.push('/settings/account');
    if (onDismiss) {
      onDismiss();
    }
  };

  return (
    // The v3 blocked-action card (C-Shell-VerifyEmail "blocked"): a floating 12px card with
    // the alert icon in a soft circle, the title, the copy and one action.
    <Alert className="flex gap-3 rounded-xl border p-4 shadow-lg">
      <span className="flex size-9 flex-none items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertCircle className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <AlertTitle className="font-semibold">Email verification required</AlertTitle>
        <AlertDescription>
          <p className="mb-3">
            You need to verify your email address before you can perform this action.
          </p>
          <Button
            onClick={handleGoToSettings}
            variant="outline"
            size="sm"
          >
            Go to Account Settings
          </Button>
        </AlertDescription>
      </div>
    </Alert>
  );
}
