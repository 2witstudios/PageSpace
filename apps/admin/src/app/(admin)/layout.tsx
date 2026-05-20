import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { verifyAdminAuth, isAdminAuthError } from '@/lib/auth/auth';
import AdminLayoutClient from '../AdminLayoutClient';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const request = new Request('http://localhost', {
    headers: { cookie: cookieStore.toString() },
  });

  const result = await verifyAdminAuth(request);
  if (isAdminAuthError(result)) {
    redirect('/login');
  }

  return <AdminLayoutClient>{children}</AdminLayoutClient>;
}
