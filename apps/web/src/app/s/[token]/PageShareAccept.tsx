'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useCSRFToken } from '@/hooks/useCSRFToken';
import type { ShareTokenInfo } from '@pagespace/lib/permissions/share-link-service';
import { isImagoEnabled } from '@/lib/imago/imago-enabled';
import {
  V3_BUTTON_PRIMARY,
  V3_H1,
  V3_LEAD,
  V3_SPINNER,
  V3_STRONG,
} from '@/components/auth/authCardV3';

interface PageShareAcceptProps {
  token: string;
  info: ShareTokenInfo;
}

export function PageShareAccept({ token, info }: PageShareAcceptProps) {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { csrfToken } = useCSRFToken();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !csrfToken) return;

    const controller = new AbortController();

    async function accept() {
      try {
        const res = await fetch(`/api/share/${token}/accept`, {
          method: 'POST',
          headers: { 'x-csrf-token': csrfToken! },
          credentials: 'include',
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError((body as { error?: string }).error ?? 'Failed to accept. Please try again.');
          return;
        }

        const data = (await res.json()) as { type: string; pageId?: string; driveId?: string; status?: string; message?: string };
        // POL-2: the org requires an Owner or Admin to approve guests; nothing is granted yet, so stay here and say so.
        if (data.status === 'pending_approval') {
          setError(data.message ?? 'Your request is waiting for approval.');
          return;
        }
        router.push(
          isImagoEnabled()
            ? `/imago/${data.driveId}/files/${data.pageId}`
            : `/dashboard/${data.driveId}/${data.pageId}`,
        );
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setError('Something went wrong. Please try again.');
      }
    }

    accept();
    return () => controller.abort();
  }, [isAuthenticated, csrfToken, token, router]);

  if (!authLoading && !isAuthenticated && isImagoEnabled()) {
    return (
      <div>
        <h1 className={V3_H1}>You’re invited</h1>
        <p className={V3_LEAD}>
          Sign in to open <strong className={V3_STRONG}>{info.pageTitle ?? 'this page'}</strong>.
        </p>
        <button
          type="button"
          className={`${V3_BUTTON_PRIMARY} mt-6`}
          onClick={() => router.push(`/auth/signin?next=/s/${token}`)}
        >
          Sign in to continue
        </button>
      </div>
    );
  }

  if (!authLoading && !isAuthenticated) {
    return (
      <div className="space-y-6 text-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            You&apos;re invited
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Sign in to open{' '}
            <span className="font-medium text-gray-900 dark:text-gray-100">
              {info.pageTitle ?? 'this page'}
            </span>
            .
          </p>
        </div>
        <Button className="w-full" onClick={() => router.push(`/auth/signin?next=/s/${token}`)}>
          Sign in to continue
        </Button>
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

  if (isImagoEnabled()) {
    return (
      <div className="space-y-4">
        <p className={V3_LEAD}>
          Opening <strong className={V3_STRONG}>{info.pageTitle ?? 'page'}</strong>…
        </p>
        <div className="flex justify-center">
          <div className={V3_SPINNER} />
        </div>
      </div>
    );
  }

  return (
    <div className="text-center space-y-4">
      <p className="text-sm text-muted-foreground">
        Opening{' '}
        <span className="font-medium text-gray-900 dark:text-gray-100">
          {info.pageTitle ?? 'page'}
        </span>
        …
      </p>
      <div className="flex justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    </div>
  );
}
