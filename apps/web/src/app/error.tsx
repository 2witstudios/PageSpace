'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error('Global error boundary caught:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-destructive" />
          </div>
          <CardTitle className="text-xl">Something went wrong</CardTitle>
          <CardDescription>
            An unexpected error occurred. Please try again or contact support.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {error.digest && (
            <div className="bg-muted p-3 rounded-md text-sm text-muted-foreground">
              Error ID: {error.digest}
            </div>
          )}

          {process.env.NODE_ENV === 'development' && (
            <div className="bg-muted p-3 rounded-md text-sm">
              <div className="font-medium mb-1">Error Details:</div>
              <div className="text-muted-foreground break-words">
                {error.message || 'An unexpected error occurred'}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <Button variant="default" onClick={reset} className="w-full">
              <RefreshCw className="w-4 h-4 mr-2" />
              Try Again
            </Button>

            <Button
              variant="outline"
              onClick={() => (window.location.href = '/dashboard')}
              className="w-full"
            >
              <Home className="w-4 h-4 mr-2" />
              Go Home
            </Button>
          </div>

          {process.env.NODE_ENV === 'development' && error.stack && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
                Development Details
              </summary>
              <div className="mt-2 p-3 bg-muted rounded-md text-xs">
                <pre className="whitespace-pre-wrap overflow-x-auto">
                  {error.stack}
                </pre>
              </div>
            </details>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
