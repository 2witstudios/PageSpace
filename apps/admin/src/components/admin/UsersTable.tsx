'use client';

import { UserRow } from '@/components/admin/users/user-row';
import type { AdminUser } from '@/components/admin/users/types';

interface UsersTableProps {
  users: AdminUser[];
  /** Called after any admin action so the page can refetch fresh data. */
  onActionComplete: () => void;
}

/**
 * Renders one page of users. Search, sort, filters, and pagination are
 * server-driven and live in the users page — this component is presentational.
 */
export function UsersTable({ users, onActionComplete }: UsersTableProps) {
  return (
    <div className="grid gap-4">
      {users.map((user) => (
        <UserRow key={user.id} user={user} onActionComplete={onActionComplete} />
      ))}
    </div>
  );
}
