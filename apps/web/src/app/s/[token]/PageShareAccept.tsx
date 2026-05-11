'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useCSRFToken } from '@/hooks/useCSRFToken';
import type { ShareTokenInfo } from '@pagespace/lib/permissions/share-link-service';

interface PageShareAcceptProps {
  token: string;
  info: ShareTokenInfo & { type: 'page' };
}

export function PageShareAccept({ token, info }: PageShareAcceptProps) {
  const router = useRouter();
  const { csrfToken } = useCSRFToken();
  const accepted = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!csrfToken || accepted.current) return;
    accepted.current = true;

    async function accept() {
      try {
        const res = await fetch(`/api/share/${token}/accept`, {
          method: 'POST',
          headers: { 'x-csrf-token': csrfToken! },
          credentials: 'include',
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError((body as { error?: string }).error ?? 'Failed to accept. Please try again.');
          return;
        }

        const data = (await res.json()) as { type: string; pageId: string; driveId: string };
        router.push(`/dashboard/${data.driveId}/${data.pageId}`);
      } catch {
        setError('Something went wrong. Please try again.');
      }
    }

    accept();
  }, [csrfToken, token, router]);

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
