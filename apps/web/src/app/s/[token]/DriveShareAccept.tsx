'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useCSRFToken } from '@/hooks/useCSRFToken';
import type { ShareTokenInfo } from '@pagespace/lib/permissions/share-link-service';

interface DriveShareAcceptProps {
  token: string;
  info: ShareTokenInfo;
}

export function DriveShareAccept({ token, info }: DriveShareAcceptProps) {
  const router = useRouter();
  const { csrfToken } = useCSRFToken();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleJoin() {
    if (!csrfToken) return;
    setIsPending(true);
    setError(null);

    try {
      const res = await fetch(`/api/share/${token}/accept`, {
        method: 'POST',
        headers: { 'x-csrf-token': csrfToken },
        credentials: 'include',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? 'Failed to join. Please try again.');
        return;
      }

      const data = (await res.json()) as { type: string; driveId: string };
      router.push(`/dashboard/${data.driveId}`);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsPending(false);
    }
  }

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

      {error && (
        <p className="text-sm text-destructive text-center">{error}</p>
      )}

      <Button
        className="w-full"
        onClick={handleJoin}
        disabled={isPending || !csrfToken}
      >
        {isPending ? 'Joining…' : `Join ${info.driveName ?? 'workspace'}`}
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
