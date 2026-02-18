import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { verifyAdminAuth, isAdminAuthError } from '@/lib/auth';
import AdminLayoutClient from './AdminLayoutClient';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

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
    redirect('/dashboard');
  }

  return <AdminLayoutClient>{children}</AdminLayoutClient>;
}