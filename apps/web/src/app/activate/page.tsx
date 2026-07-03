import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';
import { ActivateFlow } from './ActivateFlow';

interface ActivatePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * RFC 8628 device-flow verification page (task mwexjazwha2uhw5bmvc9a7kw):
 * "CLI shows a short code, human enters it here on any signed-in device."
 * Session-gated only — the user code itself is verified + rate-limited
 * server-side by `ActivateFlow`'s calls to the /verify and /decision API
 * routes, never trusted from this page's own render.
 */
export default async function ActivatePage({ searchParams }: ActivatePageProps) {
  const params = await searchParams;
  const userCode = first(params.user_code) ?? '';
  const nextTarget = userCode ? `/activate?user_code=${encodeURIComponent(userCode)}` : '/activate';

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const sessionToken = getSessionFromCookies(cookieHeader);

  if (!sessionToken) {
    redirect(`/auth/signin?next=${encodeURIComponent(nextTarget)}`);
  }

  const session = await sessionService.validateSession(sessionToken);
  if (!session) {
    redirect(`/auth/signin?next=${encodeURIComponent(nextTarget)}`);
  }

  return (
    <div className="mx-auto max-w-md py-16">
      <h1 className="text-xl font-semibold">Activate a device</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Enter the code shown on your device to connect it to your PageSpace account.
      </p>
      <ActivateFlow initialUserCode={userCode} />
    </div>
  );
}
