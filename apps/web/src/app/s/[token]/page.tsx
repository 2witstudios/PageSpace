import Link from 'next/link';
import { AuthLayout } from '@/components/auth/AuthLayout';
import { Button } from '@/components/ui/button';
import { resolveShareToken } from '@pagespace/lib/permissions/share-link-service';
import { isImagoEnabled } from '@/lib/imago/imago-enabled';
import { V3_BUTTON_SECONDARY, V3_H1, V3_LEAD } from '@/components/auth/authCardV3';
import { DriveShareAccept } from './DriveShareAccept';
import { PageShareAccept } from './PageShareAccept';

interface ShareLinkPageProps {
  params: Promise<{ token: string }>;
}

export default async function ShareLinkPage({ params }: ShareLinkPageProps) {
  const { token } = await params;
  const info = await resolveShareToken(token);

  if (!info && isImagoEnabled()) {
    return (
      <AuthLayout>
        <div>
          <span className="mb-5 grid size-11 place-items-center rounded-xl bg-[oklch(0.15_0.01_220/0.05)] text-[oklch(0.48_0.015_220)]">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
              <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
            </svg>
          </span>
          <h1 className={V3_H1}>This link is no longer valid</h1>
          <p className={V3_LEAD}>
            The link may have expired or been revoked. Ask the person who shared it to send a new one.
          </p>
          <Link href="/imago" className={`${V3_BUTTON_SECONDARY} mt-6`}>
            Go to dashboard
          </Link>
        </div>
      </AuthLayout>
    );
  }

  if (!info) {
    return (
      <AuthLayout>
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            This link is no longer valid
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            The link may have expired or been revoked. Ask the person who shared it to send a new one.
          </p>
          <div className="mt-8">
            <Link href="/dashboard">
              <Button variant="outline" className="w-full">
                Go to dashboard
              </Button>
            </Link>
          </div>
        </div>
      </AuthLayout>
    );
  }

  if (info.type === 'drive') {
    return (
      <AuthLayout>
        <DriveShareAccept token={token} info={info} />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <PageShareAccept token={token} info={info} />
    </AuthLayout>
  );
}
