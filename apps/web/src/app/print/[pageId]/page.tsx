import { notFound, redirect } from 'next/navigation';
import { db, pages, eq } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { validateJWTToken } from '@/lib/auth';
import { cookies } from 'next/headers';
import PrintView from '@/components/print/PrintView';

// Page data type for print view
interface PageData {
  id: string;
  content: string | null;
  title: string;
  type: string;
}

/**
 * Print Route - Dedicated route for pre-paginated document printing
 *
 * This route fetches document content, pre-calculates page breaks,
 * and renders fixed-height page containers for 1:1 print fidelity.
 *
 * ## Next.js 15 Pattern
 * - Uses async params (breaking change in Next.js 15)
 * - Server component for data fetching
 * - Auto-triggers print dialog via client component
 *
 * ## Authentication
 * - Validates JWT token from cookies
 * - Checks user has view permission on page
 * - Returns 401/403 for unauthorized access
 *
 * ## Usage
 * Navigate to `/print/{pageId}` to trigger print flow
 */

interface PrintPageProps {
  params: Promise<{
    pageId: string;
  }>;
}

export default async function PrintPage({ params }: PrintPageProps) {
  // CRITICAL: Next.js 15 - params is a Promise, must await
  const { pageId } = await params;

  // Authenticate request
  const cookieStore = await cookies();
  const token = cookieStore.get('auth_token')?.value;

  if (!token) {
    redirect('/login?redirect=/print/' + pageId);
  }

  // Verify JWT and get user
  const authResult = await validateJWTToken(token);

  if (!authResult) {
    redirect('/login?redirect=/print/' + pageId);
  }

  const userId = authResult.userId;

  // Fetch page data
  const [page] = await db
    .select()
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);

  if (!page) {
    notFound();
  }

  // Check permissions
  const canView = await canUserViewPage(userId, pageId);
  if (!canView) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">Access Denied</h1>
          <p className="text-muted-foreground">
            You do not have permission to print this document.
          </p>
        </div>
      </div>
    );
  }

  // Pass page data to client component for rendering
  const pageData: PageData = {
    id: page.id,
    content: page.content,
    title: page.title,
    type: page.type,
  };

  return <PrintView page={pageData} />;
}
