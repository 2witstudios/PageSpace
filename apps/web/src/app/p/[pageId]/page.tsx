import { redirect, notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { db, pages, eq } from '@pagespace/db';
import { getUserAccessLevel } from '@pagespace/lib/server';
import { sessionService } from '@pagespace/lib/auth';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';

interface PageProps {
  params: Promise<{ pageId: string }>;
}

/**
 * Page redirect route - navigates to the correct dashboard URL for a page
 * This allows mentions to link directly to a page ID without knowing the driveId
 */
export default async function PageRedirect({ params }: PageProps) {
  const { pageId } = await params;

  // Get session token from cookies
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const sessionToken = getSessionFromCookies(cookieHeader);

  if (!sessionToken) {
    redirect(`/auth/signin?callbackUrl=/p/${pageId}`);
  }

  // Validate the session token
  const session = await sessionService.validateSession(sessionToken);
  if (!session) {
    redirect(`/auth/signin?callbackUrl=/p/${pageId}`);
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
  redirect(`/dashboard/${page.driveId}/${pageId}`);
}
