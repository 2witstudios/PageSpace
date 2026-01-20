"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
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
import { GoogleOneTap } from "@/components/auth";

function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { actions, isLoading } = useAuth();

  useEffect(() => {
    const error = searchParams.get('error');
    const newAccount = searchParams.get('newAccount');
    
    if (newAccount) {
      toast.info('Your account was created successfully! Please sign in to continue.');
    }
    
    if (error) {
      switch (error) {
        case 'access_denied':
          toast.error('Google sign-in was cancelled. Please try again if you want to continue.');
          break;
        case 'oauth_error':
          toast.error('Google sign-in failed. Please try again.');
          break;
        case 'rate_limit':
          toast.error('Too many login attempts. Please try again later.');
          break;
        case 'invalid_request':
          toast.error('Invalid request. Please try again.');
          break;
        default:
          toast.error('An error occurred during sign-in.');
      }
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Prevent double submission
    if (isLoading) return;
    
    setError(null);

    try {
      const result = await actions.login(email, password);

      if (result.success) {
        // Show success message
        toast.success("Welcome back! You've been signed in successfully.");
        
        // Use replace to avoid back navigation issues
        router.replace(result.redirectTo ?? '/dashboard');
      } else {
        const errorMessage = result.error || 'An unexpected error occurred.';
        setError(errorMessage);
        toast.error(errorMessage);
      }
    } catch (error) {
      console.error('Login error:', error);
      const networkError = 'Network error. Please check your connection and try again.';
      setError(networkError);
      toast.error(networkError);
    }
  };

  const handleGoogleSignIn = async () => {
    if (isGoogleLoading) return;

    setIsGoogleLoading(true);
    setError(null);

    try {
      // Detect platform and get deviceId for ALL platforms
      const isDesktop = typeof window !== 'undefined' && window.electron?.isDesktop;
      let deviceId: string;
      let deviceName: string;

      if (isDesktop && window.electron) {
        // Desktop: Get device info from Electron
        const deviceInfo = await window.electron.auth.getDeviceInfo();
        deviceId = deviceInfo.deviceId;
        deviceName = deviceInfo.deviceName;
      } else {
        // Web browser: Use fingerprint utility for device identification
        const { getOrCreateDeviceId, getDeviceName } = await import('@/lib/analytics');
        deviceId = getOrCreateDeviceId();
        deviceName = getDeviceName();
      }

      const response = await fetch('/api/auth/google/signin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          platform: isDesktop ? 'desktop' : 'web',
          deviceId,
          deviceName,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        window.location.href = data.url;
      } else {
        const errorData = await response.json();
        const errorMessage = errorData.error || 'Google sign-in failed. Please try again.';
        setError(errorMessage);
        toast.error(errorMessage);
      }
    } catch (error) {
      console.error('Google sign-in error:', error);
      const networkError = 'Network error. Please check your connection and try again.';
      setError(networkError);
      toast.error(networkError);
    } finally {
      setIsGoogleLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100 dark:bg-gray-900">
      {/* Google One Tap - displays automatically for signed-in Google users */}
      <GoogleOneTap
        onSuccess={() => {
          // Toast handled internally by GoogleOneTap
        }}
        onError={(error) => {
          console.error('Google One Tap error:', error);
        }}
        autoSelect={true}
        cancelOnTapOutside={true}
        context="signin"
      />
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Sign In</CardTitle>
          <CardDescription>
            Enter your credentials to access your account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
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
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {error && <p className="text-red-500 text-sm">{error}</p>}
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <div className="flex items-center gap-2">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    <span>Signing In...</span>
                  </div>
                ) : (
                  "Sign In"
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
                disabled={isGoogleLoading || isLoading}
                onClick={handleGoogleSignIn}
              >
                {isGoogleLoading ? (
                  <div className="flex items-center gap-2">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600"></div>
                    <span>Connecting to Google...</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    <span>Continue with Google</span>
                  </div>
                )}
              </Button>
            </div>
          </form>
          <div className="mt-4 text-center text-sm">
            Don&apos;t have an account?{" "}
            <Link href="/auth/signup" className="underline">
              Sign up
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function SignIn() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen bg-gray-100 dark:bg-gray-900">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-2xl">Sign In</CardTitle>
            <CardDescription>
              Loading...
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    }>
      <SignInForm />
    </Suspense>
  );
}
