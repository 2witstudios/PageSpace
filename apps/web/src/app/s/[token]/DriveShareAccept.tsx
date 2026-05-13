'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { useCSRFToken } from '@/hooks/useCSRFToken';
import type { ShareTokenInfo } from '@pagespace/lib/permissions/share-link-service';

interface DriveShareAcceptProps {
  token: string;
  info: ShareTokenInfo;
}

export function DriveShareAccept({ token, info }: DriveShareAcceptProps) {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { csrfToken } = useCSRFToken();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !csrfToken) return;

    const controller = new AbortController();

    async function accept() {
      setIsPending(true);
      try {
        const res = await fetch(`/api/share/${token}/accept`, {
          method: 'POST',
          headers: { 'x-csrf-token': csrfToken! },
          credentials: 'include',
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError((body as { error?: string }).error ?? 'Failed to join. Please try again.');
          return;
        }

        const data = (await res.json()) as { type: string; driveId: string };
        router.push(`/dashboard/${data.driveId}`);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setError('Something went wrong. Please try again.');
      } finally {
        setIsPending(false);
      }
    }

    accept();
    return () => controller.abort();
  }, [isAuthenticated, csrfToken, token, router]);

  if (authLoading || (isAuthenticated && (!csrfToken || isPending) && !error)) {
    return (
      <div className="text-center space-y-4">
        <p className="text-sm text-muted-foreground">
          Joining{' '}
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {info.driveName ?? 'workspace'}
          </span>
          …
        </p>
        <div className="flex justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            Join{' '}
            <span className="text-blue-600 dark:text-blue-400">
              {info.driveName ?? 'this workspace'}
            </span>
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            <span className="font-medium text-gray-900 dark:text-gray-100">{info.creatorName}</span>
            {' '}shared an invite link.{' '}
            You&apos;ll join as a{' '}
            <Badge variant="secondary" className="text-xs">
              {info.role ?? 'Member'}
            </Badge>
            .
          </p>
        </div>

        <Button className="w-full" onClick={() => router.push(`/auth/signin?next=${encodeURIComponent(`/s/${token}`)}`)}>
          Sign in to join
        </Button>

        <div className="text-center">
          <Link
            href="/dashboard"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Not now
          </Link>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            Something went wrong
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">{error}</p>
        </div>
        <Link href="/dashboard">
          <Button variant="outline" className="w-full">Go to dashboard</Button>
        </Link>
      </div>
    );
  }

  return null;
}
