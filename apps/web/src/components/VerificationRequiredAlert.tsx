'use client';

import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Mail, CheckCircle2 } from 'lucide-react';

interface VerificationRequiredAlertProps {
  onDismiss?: () => void;
}

export function VerificationRequiredAlert({ onDismiss }: VerificationRequiredAlertProps) {
  const [loading, setLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const { toast } = useToast();

  const handleResendEmail = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to send verification email');
      }

      setEmailSent(true);
      toast({
        title: 'Email sent',
        description: data.message || 'Verification email sent successfully. Please check your inbox.',
      });

      // Auto-dismiss after 3 seconds on success
      if (onDismiss) {
        setTimeout(onDismiss, 3000);
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to send verification email',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  if (emailSent) {
    return (
      <Alert>
        <CheckCircle2 className="h-4 w-4 text-green-600" />
        <AlertTitle>Email sent!</AlertTitle>
        <AlertDescription>
          Check your inbox for the verification link.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive">
      <Mail className="h-4 w-4" />
      <AlertTitle>Email verification required</AlertTitle>
      <AlertDescription>
        <p className="mb-2">
          You need to verify your email address before you can perform this action.
        </p>
        <Button
          onClick={handleResendEmail}
          disabled={loading}
          variant="outline"
          size="sm"
        >
          {loading ? 'Sending...' : 'Resend Verification Email'}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
