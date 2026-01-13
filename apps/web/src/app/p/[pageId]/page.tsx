import { redirect, notFound } from 'next/navigation';
import { db, pages, eq } from '@pagespace/db';
import { getCurrentUser } from '@/lib/auth';
import { getUserAccessLevel } from '@pagespace/lib/server';

interface PageProps {
  params: Promise<{ pageId: string }>;
}

/**
 * Page redirect route - navigates to the correct dashboard URL for a page
 * This allows mentions to link directly to a page ID without knowing the driveId
 */
export default async function PageRedirect({ params }: PageProps) {
  const { pageId } = await params;

  // Verify user is authenticated
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/auth/signin?callbackUrl=/p/${pageId}`);
  }

  // Look up the page to get its driveId
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { id: true, driveId: true, isTrashed: true },
  });

  if (!page) {
    notFound();
  }

  // Check user has access to the page
  const accessLevel = await getUserAccessLevel(user.id, pageId);
  if (!accessLevel) {
    notFound();
  }

  // Redirect to the full dashboard URL
  redirect(`/dashboard/${page.driveId}/${pageId}`);
}
