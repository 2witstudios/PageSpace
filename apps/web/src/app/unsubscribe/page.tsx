'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Loader2, MailX } from 'lucide-react';

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
  PRODUCT_UPDATE: 'Product Updates',
};

/**
 * Confirmation step for an emailed unsubscribe link.
 *
 * The link in an email is a GET, and GETs get fetched by machines — spam filters,
 * link scanners, corporate mail gateways. If the GET itself unsubscribed, a
 * scanner could opt someone out of email they never chose to leave. So the opt-out
 * only happens when this button POSTs.
 */
function UnsubscribeConfirm() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const token = searchParams.get('token') ?? '';
  const notificationType = searchParams.get('type') ?? 'unknown';
  const label = NOTIFICATION_TYPE_LABELS[notificationType] ?? 'these notifications';

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`/api/notifications/unsubscribe/${encodeURIComponent(token)}`, {
        method: 'POST',
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? 'That unsubscribe link is no longer valid.');
        setSubmitting(false);
        return;
      }

      router.push(`/unsubscribe-success?type=${encodeURIComponent(notificationType)}`);
    } catch {
      setError('Something went wrong. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mb-4">
        <MailX className="w-10 h-10 text-purple-600" />
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-2">Unsubscribe?</h1>

      <p className="text-gray-600 mb-6">
        This will stop <strong>{label}</strong> emails from PageSpace. You can turn them back on any
        time in your notification settings.
      </p>

      {error ? (
        <div className="w-full bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-3 w-full">
        <button
          type="button"
          onClick={confirm}
          disabled={submitting || !token}
          className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white font-medium py-2.5 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {submitting ? 'Unsubscribing…' : 'Yes, unsubscribe me'}
        </button>

        <Link
          href="/settings/notifications"
          className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium py-2.5 px-4 rounded-lg transition-colors"
        >
          Keep them, manage preferences
        </Link>
      </div>
    </div>
  );
}

export default function UnsubscribePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 to-blue-50 p-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-xl p-8">
        <Suspense
          fallback={
            <div className="flex justify-center">
              <Loader2 className="w-8 h-8 animate-spin text-purple-600" />
            </div>
          }
        >
          <UnsubscribeConfirm />
        </Suspense>
      </div>
    </div>
  );
}
