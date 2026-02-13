import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { verifyAdminAuth, isAdminAuthError } from '@/lib/auth';
import AdminLayoutClient from './AdminLayoutClient';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Create a request object with cookies for authentication
  const cookieStore = await cookies();
  const request = new Request('http://localhost', {
    headers: {
      cookie: cookieStore.toString(),
    },
  });

  // Verify user is authenticated and is an admin
  const adminAuthResult = await verifyAdminAuth(request);

  if (isAdminAuthError(adminAuthResult)) {
    // Redirect non-admin users to home page
    redirect('/');
  }

  return <AdminLayoutClient>{children}</AdminLayoutClient>;
}