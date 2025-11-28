"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getOrCreateDeviceId, getDeviceName } from "@/lib/analytics/device-fingerprint";

export default function SignUp() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedTos, setAcceptedTos] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("Creating account...");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Prevent double submission
    if (isLoading) return;

    setError(null);

    // Client-side password match validation
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      toast.error("Passwords do not match");
      return;
    }

    // Client-side TOS acceptance validation
    if (!acceptedTos) {
      setError("You must accept the Terms of Service and Privacy Policy");
      toast.error("You must accept the Terms of Service and Privacy Policy");
      return;
    }

    setIsLoading(true);
    setLoadingMessage("Creating account...");

    try {
      // Get device information for device token creation
      const deviceId = getOrCreateDeviceId();
      const deviceName = getDeviceName();
      const existingDeviceToken = typeof localStorage !== 'undefined' ? localStorage.getItem('deviceToken') : null;

      const signupResponse = await fetch("/api/auth/signup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          email,
          password,
          confirmPassword,
          acceptedTos,
          deviceId,
          deviceName,
          ...(existingDeviceToken && { deviceToken: existingDeviceToken }),
        }),
        credentials: 'include',
        redirect: 'manual', // Don't auto-follow redirects, we'll handle them
      });

      // Handle successful signup (303 redirect)
      if (signupResponse.status === 303 || signupResponse.type === 'opaqueredirect') {
        // Success! Server sent redirect
        toast.success(`Welcome to PageSpace, ${name}! Let's get started.`);
        setLoadingMessage("Taking you to your dashboard...");

        // Navigate to dashboard (or follow the Location header)
        const location = signupResponse.headers.get('Location') || '/dashboard?auth=success';
        window.location.href = location;
        return;
      }

      // Handle error responses (server returns JSON for errors)
      if (!signupResponse.ok) {
        try {
          const signupData = await signupResponse.json();
          let errorMessage = 'An unexpected error occurred during signup.';

          if (signupData.errors) {
            // Handle validation errors
            const fieldErrors = signupData.errors;
            const errorMessages = [];
            if (fieldErrors.name) errorMessages.push(...fieldErrors.name);
            if (fieldErrors.email) errorMessages.push(...fieldErrors.email);
            if (fieldErrors.password) errorMessages.push(...fieldErrors.password);
            if (fieldErrors.confirmPassword) errorMessages.push(...fieldErrors.confirmPassword);
            errorMessage = errorMessages.join(', ');
          } else if (signupData.error) {
            errorMessage = signupData.error;
          }

          setError(errorMessage);
          toast.error(errorMessage);
        } catch {
          // Failed to parse error response
          setError('An unexpected error occurred during signup.');
          toast.error('An unexpected error occurred during signup.');
        }
        return;
      }

      // If we reach here, something unexpected happened
      setError('Unexpected response from server');
      toast.error('Unexpected response from server');

    } catch (error) {
      console.error('Sign up error:', error);
      const networkError = 'Network error. Please check your connection and try again.';
      setError(networkError);
      toast.error(networkError);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100 dark:bg-gray-900">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Sign Up</CardTitle>
          <CardDescription>
            Enter your information to create an account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  name="name"
                  autoComplete="name"
                  placeholder="John Doe"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="m@example.com"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="confirmPassword">Confirm Password</Label>
                <Input
                  id="confirmPassword"
                  name="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  id="acceptedTos"
                  checked={acceptedTos}
                  onChange={(e) => setAcceptedTos(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  required
                />
                <label htmlFor="acceptedTos" className="text-sm text-muted-foreground">
                  I agree to the{" "}
                  <Link href="/terms" target="_blank" className="underline hover:text-foreground">
                    Terms of Service
                  </Link>{" "}
                  and{" "}
                  <Link href="/privacy" target="_blank" className="underline hover:text-foreground">
                    Privacy Policy
                  </Link>
                </label>
              </div>
              {error && <p className="text-red-500 text-sm">{error}</p>}
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <div className="flex items-center gap-2">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    <span>{loadingMessage}</span>
                  </div>
                ) : (
                  "Create an account"
                )}
              </Button>
              
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">
                    Or continue with
                  </span>
                </div>
              </div>
              
              <Button 
                type="button" 
                variant="outline" 
                className="w-full" 
                disabled={isLoading}
                onClick={() => window.location.href = '/api/auth/google/signin'}
              >
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  <span>Continue with Google</span>
                </div>
              </Button>
            </div>
          </form>
          <div className="mt-4 text-center text-sm">
            Already have an account?{" "}
            <Link href="/auth/signin" className="underline">
              Sign in
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}