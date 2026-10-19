'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { AuthLayout } from '@/components/auth/AuthLayout';
import {
  V3_BODY,
  V3_HEADING,
  V3_ICON_BOX_SUCCESS,
  V3_PRIMARY_BUTTON,
  V3_SECONDARY_BUTTON,
} from '@/components/auth/auth-v3-styles';
import { isV3AuthEnabled } from '@/lib/imago/v3-auth-enabled';
import { NOTIFICATION_TYPE_LABELS, getNotificationPreferencesHref } from '@/lib/notifications/unsubscribe-copy';

function UnsubscribeContent() {
  const searchParams = useSearchParams();
  const v3 = isV3AuthEnabled();
  const notificationType = searchParams.get('type') || 'unknown';
  const label = NOTIFICATION_TYPE_LABELS[notificationType] || 'this notification type';
  const preferencesHref = getNotificationPreferencesHref();

  if (v3) {
    return (
      <div className="flex flex-col">
        <span className={V3_ICON_BOX_SUCCESS}>
          <CheckCircle2 className="size-[22px]" aria-hidden="true" />
        </span>
        <h1 className={V3_HEADING}>Unsubscribed Successfully</h1>
        <p className={V3_BODY}>
          You&apos;ve been unsubscribed from <strong>{label}</strong> email notifications.
        </p>
        <p className="mt-4 rounded-[10px] border border-[oklch(0.85_0.04_235)] bg-[oklch(0.97_0.02_235)] p-3.5 text-sm leading-[1.55] text-[oklch(0.35_0.03_220)]">
          You&apos;ll still receive these notifications within PageSpace, but we won&apos;t send them to your email.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <Link href={preferencesHref} className={`${V3_PRIMARY_BUTTON} no-underline`}>
            Manage All Preferences
          </Link>
          <Link href="/dashboard" className={`${V3_SECONDARY_BUTTON} no-underline`}>
            Return to PageSpace
          </Link>
        </div>
      </div>
    );
  }

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
          href={preferencesHref}
          className="w-full bg-purple-600 hover:bg-purple-700 text-white font-medium py-2.5 px-4 rounded-lg transition-colors"
        >
          Manage All Preferences
        </Link>

        <Link
          href="/dashboard"
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
    <AuthLayout classic="bare">
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
          </div>
        }
      >
        <UnsubscribeContent />
      </Suspense>
    </AuthLayout>
  );
}
