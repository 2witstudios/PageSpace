import Link from 'next/link';
import { AuthShell } from '@/components/auth/AuthShell';
import { Button } from '@/components/ui/button';
import { resolveShareToken } from '@pagespace/lib/permissions/share-link-service';
import { DriveShareAccept } from './DriveShareAccept';
import { PageShareAccept } from './PageShareAccept';

interface ShareLinkPageProps {
  params: Promise<{ token: string }>;
}

export default async function ShareLinkPage({ params }: ShareLinkPageProps) {
  const { token } = await params;
  const info = await resolveShareToken(token);

  if (!info) {
    return (
      <AuthShell>
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
      </AuthShell>
    );
  }

  if (info.type === 'drive') {
    return (
      <AuthShell>
        <DriveShareAccept token={token} info={info} />
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <PageShareAccept token={token} info={info} />
    </AuthShell>
  );
}
