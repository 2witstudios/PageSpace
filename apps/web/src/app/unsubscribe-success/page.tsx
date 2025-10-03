'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, Loader2 } from 'lucide-react';

const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  PERMISSION_GRANTED: 'Collaborator Added',
  PERMISSION_REVOKED: 'Permission Revoked',
  PERMISSION_UPDATED: 'Permission Updated',
  PAGE_SHARED: 'Page Shared',
  DRIVE_INVITED: 'Workspace Additions',
  DRIVE_JOINED: 'Drive Joined',
  DRIVE_ROLE_CHANGED: 'Drive Role Changed',
  CONNECTION_REQUEST: 'Connection Requests',
  CONNECTION_ACCEPTED: 'Connection Accepted',
  CONNECTION_REJECTED: 'Connection Rejected',
  NEW_DIRECT_MESSAGE: 'Direct Messages',
};

function UnsubscribeContent() {
  const searchParams = useSearchParams();
  const notificationType = searchParams.get('type') || 'unknown';
  const label = NOTIFICATION_TYPE_LABELS[notificationType] || 'this notification type';

  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
        <CheckCircle2 className="w-10 h-10 text-green-600" />
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-2">
        Unsubscribed Successfully
      </h1>

      <p className="text-gray-600 mb-6">
        You&apos;ve been unsubscribed from <strong>{label}</strong> email notifications.
      </p>

      <div className="w-full bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <p className="text-sm text-gray-700">
          You&apos;ll still receive these notifications within PageSpace, but we won&apos;t send them to your email.
        </p>
      </div>

      <div className="flex flex-col gap-3 w-full">
        <Link
          href="/settings/notifications"
          className="w-full bg-purple-600 hover:bg-purple-700 text-white font-medium py-2.5 px-4 rounded-lg transition-colors"
        >
          Manage All Preferences
        </Link>

        <Link
          href="/"
          className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium py-2.5 px-4 rounded-lg transition-colors"
        >
          Return to PageSpace
        </Link>
      </div>
    </div>
  );
}

export default function UnsubscribeSuccessPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-blue-50 p-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-xl p-8">
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
            </div>
          }
        >
          <UnsubscribeContent />
        </Suspense>
      </div>
    </div>
  );
}
