'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Loader2, MailX } from 'lucide-react';
import { AuthLayout } from '@/components/auth/AuthLayout';
import {
  V3_BODY,
  V3_ERROR_TEXT,
  V3_HEADING,
  V3_ICON_BOX,
  V3_PRIMARY_BUTTON,
  V3_SECONDARY_BUTTON,
} from '@/components/auth/auth-v3-styles';
import { isImagoEnabled } from '@/lib/imago/imago-enabled';
import { NOTIFICATION_TYPE_LABELS, getNotificationPreferencesHref } from '@/lib/notifications/unsubscribe-copy';

const INVALID_LINK_MESSAGE = 'That unsubscribe link is no longer valid.';
const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

type ConfirmStatus = 'confirm' | 'invalid';

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
  const v3 = isImagoEnabled();

  const token = searchParams.get('token') ?? '';
  const notificationType = searchParams.get('type') ?? 'unknown';
  const label = NOTIFICATION_TYPE_LABELS[notificationType] ?? 'these notifications';
  const preferencesHref = getNotificationPreferencesHref();

  const [status, setStatus] = useState<ConfirmStatus>(token ? 'confirm' : 'invalid');
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
        // 4xx means the token itself was rejected (expired, unknown, bad type).
        // Anything else is a server problem, so the link may still work later.
        if (response.status >= 400 && response.status < 500) {
          setStatus('invalid');
        } else {
          setError(GENERIC_ERROR_MESSAGE);
        }
        setSubmitting(false);
        return;
      }

      router.push(`/unsubscribe-success?type=${encodeURIComponent(notificationType)}`);
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
      setSubmitting(false);
    }
  };

  const invalid = status === 'invalid';
  const alertMessage = invalid ? INVALID_LINK_MESSAGE : error;

  if (v3) {
    return (
      <div className="flex flex-col">
        <span className={V3_ICON_BOX}>
          <MailX className="size-[22px]" aria-hidden="true" />
        </span>
        <h1 className={V3_HEADING}>Unsubscribe?</h1>
        <p className={V3_BODY}>
          This will stop <strong>{label}</strong> emails from PageSpace. You can turn them back on any time in your
          notification settings.
        </p>
        {alertMessage && (
          <p role="alert" className={V3_ERROR_TEXT}>
            {alertMessage}
          </p>
        )}
        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={confirm}
            disabled={submitting || invalid || !token}
            className={V3_PRIMARY_BUTTON}
          >
            Yes, unsubscribe me
          </button>
          <Link href={preferencesHref} className={`${V3_SECONDARY_BUTTON} no-underline`}>
            Keep them, manage preferences
          </Link>
        </div>
      </div>
    );
  }

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

      {alertMessage ? (
        <div role="alert" className="w-full bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p className="text-sm text-red-700">{alertMessage}</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-3 w-full">
        <button
          type="button"
          onClick={confirm}
          disabled={submitting || invalid || !token}
          className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white font-medium py-2.5 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {submitting ? 'Unsubscribing…' : 'Yes, unsubscribe me'}
        </button>

        <Link
          href={preferencesHref}
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
    <AuthLayout classic="bare">
      <Suspense
        fallback={
          <div className="flex justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-purple-600" />
          </div>
        }
      >
        <UnsubscribeConfirm />
      </Suspense>
    </AuthLayout>
  );
}
