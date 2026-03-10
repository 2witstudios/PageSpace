"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Mail, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { post } from '@/lib/auth/auth-fetch';

interface EmailVerificationSectionProps {
  email: string;
  emailVerified: Date | null | undefined;
  isLoading: boolean;
  error?: unknown;
}

export function EmailVerificationSection({ email, emailVerified, isLoading, error: verificationError }: EmailVerificationSectionProps) {
  const [isResending, setIsResending] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const handleResend = async () => {
    setIsResending(true);
    try {
      const data = await post<{ message: string }>("/api/auth/resend-verification");
      setEmailSent(true);
      toast.success(data.message || "Verification email sent. Please check your inbox.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send verification email");
    } finally {
      setIsResending(false);
    }
  };

  const renderStatusBadge = () => {
    if (isLoading) {
      return (
        <Badge variant="outline">
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />Checking...
        </Badge>
      );
    }
    if (verificationError) {
      return (
        <Badge variant="destructive">
          <AlertCircle className="h-3 w-3 mr-1" />Error
        </Badge>
      );
    }
    if (emailVerified) {
      return (
        <Badge variant="default" className="bg-green-600">
          <CheckCircle2 className="h-3 w-3 mr-1" />Verified
        </Badge>
      );
    }
    return (
      <Badge variant="destructive">
        <AlertCircle className="h-3 w-3 mr-1" />Unverified
      </Badge>
    );
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Email Verification</CardTitle>
            <CardDescription>Verify your email to unlock all features</CardDescription>
          </div>
          {renderStatusBadge()}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking verification status...
          </div>
        ) : verificationError ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>Failed to load verification status. Please refresh the page.</AlertDescription>
          </Alert>
        ) : emailVerified ? (
          <Alert>
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <AlertDescription>Your email address has been verified.</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-4">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                <p className="mb-2">Please verify your email address to unlock all features:</p>
                <ul className="list-disc list-inside text-sm space-y-1 ml-2">
                  <li>Send drive invitations</li>
                  <li>Send connection requests</li>
                  <li>Send direct messages</li>
                </ul>
              </AlertDescription>
            </Alert>
            {emailSent ? (
              <Alert>
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <AlertDescription>
                  Verification email sent! Please check your inbox at <strong>{email}</strong>
                </AlertDescription>
              </Alert>
            ) : (
              <div>
                <p className="text-sm text-muted-foreground mb-3">
                  Didn&apos;t receive the verification email? Click below to send a new one to <strong>{email}</strong>
                </p>
                <Button onClick={handleResend} disabled={isResending}>
                  {isResending ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sending...</>
                  ) : (
                    <><Mail className="mr-2 h-4 w-4" />Resend Verification Email</>
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
