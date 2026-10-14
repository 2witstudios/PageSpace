'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { useCSRFToken } from '@/hooks/useCSRFToken';
import type { ShareTokenInfo } from '@pagespace/lib/permissions/share-link-service';
import { isImagoEnabled } from '@/lib/imago/imago-enabled';
import {
  V3_BUTTON_PRIMARY,
  V3_ACCENT,
  V3_FINE,
  V3_H1,
  V3_LEAD,
  V3_LINK,
  V3_SPINNER,
  V3_STRONG,
} from '@/components/auth/authCardV3';

interface DriveShareAcceptProps {
  token: string;
  info: ShareTokenInfo;
}

export function DriveShareAccept({ token, info }: DriveShareAcceptProps) {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { csrfToken, isLoading: csrfLoading, error: csrfError } = useCSRFToken();
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
          if (!controller.signal.aborted) {
            setError((body as { error?: string }).error ?? 'Failed to join. Please try again.');
          }
          return;
        }

        const data = (await res.json()) as { type: string; driveId?: string; status?: string; message?: string };
        // POL-2: the org requires an Owner or Admin to approve guests; nothing is granted yet, so stay here and say so.
        if (data.status === 'pending_approval') {
          if (!controller.signal.aborted) setError(data.message ?? 'Your request is waiting for approval.');
          return;
        }
        router.push(isImagoEnabled() ? `/imago/${data.driveId}` : `/dashboard/${data.driveId}`);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        if (!controller.signal.aborted) {
          setError('Something went wrong. Please try again.');
        }
      } finally {
        if (!controller.signal.aborted) setIsPending(false);
      }
    }

    accept();
    return () => controller.abort();
  }, [isAuthenticated, csrfToken, token, router]);

  const joining = authLoading || (isAuthenticated && (csrfLoading || isPending) && !error);
  const driveName = info.driveName ?? 'workspace';

  if (joining && isImagoEnabled()) {
    return (
      <div className="space-y-4">
        <p className={V3_LEAD}>
          Joining <strong className={V3_STRONG}>{driveName}</strong>…
        </p>
        <div className="flex justify-center">
          <div className={V3_SPINNER} />
        </div>
      </div>
    );
  }

  if (!isAuthenticated && isImagoEnabled()) {
    return (
      <div>
        <h1 className={V3_H1}>
          Join <span className={V3_ACCENT}>{info.driveName ?? 'this workspace'}</span>
        </h1>
        <p className={V3_LEAD}>
          <strong className={V3_STRONG}>{info.creatorName}</strong> shared an invite link. You&apos;ll join as a{' '}
          <span className={V3_STRONG}>{info.role ?? 'Member'}</span>.
        </p>
        <button
          type="button"
          className={`${V3_BUTTON_PRIMARY} mt-6`}
          onClick={() => router.push(`/auth/signin?next=${encodeURIComponent(`/s/${token}`)}`)}
        >
          Sign in to join
        </button>
        <p className={`${V3_LEAD} text-center`}>
          New to PageSpace?{' '}
          <Link href={`/auth/signup?next=${encodeURIComponent(`/s/${token}`)}`} className={V3_LINK}>
            Create an account
          </Link>
        </p>
        <div className="mt-4 text-center">
          <Link href="/imago" className={V3_FINE}>
            Not now
          </Link>
        </div>
      </div>
    );
  }

  if (joining) {
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

        <p className="text-center text-sm text-muted-foreground">
          New to PageSpace?{' '}
          <Link
            href={`/auth/signup?next=${encodeURIComponent(`/s/${token}`)}`}
            className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
          >
            Create an account
          </Link>
        </p>

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

  if (csrfError || error) {
    return (
      <div className="text-center space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            Something went wrong
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {error ?? 'Something went wrong. Please try again.'}
          </p>
        </div>
        <Link href="/dashboard">
          <Button variant="outline" className="w-full">Go to dashboard</Button>
        </Link>
      </div>
    );
  }

  return null;
}
