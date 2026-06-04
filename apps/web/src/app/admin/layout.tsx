import { redirect } from 'next/navigation';

const ADMIN_APP_URL = process.env.NEXT_PUBLIC_ADMIN_APP_URL ?? 'http://localhost:3005';

export default function AdminLayout() {
  redirect(ADMIN_APP_URL);
}
