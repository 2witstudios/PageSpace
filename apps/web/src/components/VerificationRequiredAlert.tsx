'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
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
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Email verification required</AlertTitle>
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
    </Alert>
  );
}
