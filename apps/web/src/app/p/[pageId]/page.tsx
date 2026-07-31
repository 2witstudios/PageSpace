import { redirect, notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core';
import { getUserAccessLevel } from '@pagespace/lib/permissions/permissions';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';

interface PageProps {
  params: Promise<{ pageId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Page redirect route - navigates to the correct dashboard URL for a page
 * This allows mentions to link directly to a page ID without knowing the driveId
 */
export default async function PageRedirect({ params, searchParams }: PageProps) {
  const { pageId } = await params;
  // Forwarded verbatim (e.g. `?tab=settings` from the agents console's
  // Settings link) — this route only resolves the driveId, it must not drop
  // query params the destination page itself interprets.
  const query = new URLSearchParams(
    Object.entries(await searchParams).flatMap(([key, value]): [string, string][] =>
      value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((v) => [key, v]),
    ),
  ).toString();

  // Get session token from cookies
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const sessionToken = getSessionFromCookies(cookieHeader);

  const callbackUrl = query ? `/p/${pageId}?${query}` : `/p/${pageId}`;

  if (!sessionToken) {
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  // Validate the session token — only a browser session may drive this redirect.
  const session = await sessionService.validateSession(sessionToken, { expectedType: 'user' });
  if (!session) {
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  const userId = session.userId;

  // Look up the page to get its driveId
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { id: true, driveId: true, isTrashed: true },
  });

  if (!page || page.isTrashed) {
    notFound();
  }

  // Check user has access to the page
  const accessLevel = await getUserAccessLevel(userId, pageId);
  if (!accessLevel) {
    notFound();
  }

  // Redirect to the full dashboard URL
  redirect(query ? `/dashboard/${page.driveId}/${pageId}?${query}` : `/dashboard/${page.driveId}/${pageId}`);
}
