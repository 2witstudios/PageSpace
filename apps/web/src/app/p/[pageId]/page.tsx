import { redirect, notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { db, pages, eq } from '@pagespace/db';
import { decodeToken, getUserAccessLevel } from '@pagespace/lib/server';

interface PageProps {
  params: Promise<{ pageId: string }>;
}

/**
 * Page redirect route - navigates to the correct dashboard URL for a page
 * This allows mentions to link directly to a page ID without knowing the driveId
 */
export default async function PageRedirect({ params }: PageProps) {
  const { pageId } = await params;

  // Get JWT token from cookies
  const cookieStore = await cookies();
  const token = cookieStore.get('token')?.value;

  if (!token) {
    redirect(`/auth/signin?callbackUrl=/p/${pageId}`);
  }

  // Verify the token
  const payload = await decodeToken(token);
  if (!payload) {
    redirect(`/auth/signin?callbackUrl=/p/${pageId}`);
  }

  const userId = payload.userId;

  // Look up the page to get its driveId
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { id: true, driveId: true, isTrashed: true },
  });

  if (!page) {
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
