'use client';

import { use, useState } from 'react';
import useSWR from 'swr';
import { AuthLayout } from '@/components/auth/AuthLayout';
import {
  V3_BODY,
  V3_HEADING,
  V3_ICON_BOX_DANGER,
  V3_ICON_BOX_SUCCESS,
  V3_MONO,
  V3_PRIMARY_BUTTON,
} from '@/components/auth/auth-v3-styles';
import { isImagoEnabled } from '@/lib/imago/imago-enabled';

const TENANT_BASE_DOMAIN = process.env.NEXT_PUBLIC_TENANT_BASE_DOMAIN || 'pagespace.ai';
const POLL_INTERVAL_MS = 3000;

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Status check failed (${res.status})`);
  return res.json();
};

type ProvisioningStatus = {
  slug: string;
  status: 'provisioning' | 'active' | 'failed';
};

type DisplayStatus = 'provisioning' | 'active' | 'failed' | 'error';

export default function ProvisioningStatusPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [lastStatus, setLastStatus] = useState<string>('provisioning');
  const v3 = isImagoEnabled();
  const host = `${slug}.${TENANT_BASE_DOMAIN}`;

  const { data, error } = useSWR<ProvisioningStatus>(
    `/api/provisioning-status/${slug}`,
    fetcher,
    {
      refreshInterval: POLL_INTERVAL_MS,
      isPaused: () => lastStatus === 'active' || lastStatus === 'failed',
      revalidateOnFocus: false,
      onSuccess: (d) => setLastStatus(d.status),
    }
  );

  const status: DisplayStatus = error ? 'error' : (data?.status ?? 'provisioning');

  if (v3) {
    return (
      <AuthLayout classic="bare">
        <div className="flex flex-col">
          {status === 'provisioning' && (
            <>
              <div className="mb-6">
                <span
                  aria-hidden="true"
                  className="inline-block size-9 animate-spin rounded-full border-[3px] border-[oklch(0.50_0.16_235/0.25)] border-t-[oklch(0.50_0.16_235)]"
                />
              </div>
              <h1 className={V3_HEADING}>Setting up your environment</h1>
              <p className={V3_BODY}>Your environment is being set up. This usually takes a few minutes.</p>
              <p className={`mt-[18px] ${V3_MONO}`}>{host} · checking every 3s</p>
            </>
          )}

          {status === 'active' && (
            <>
              <span className={V3_ICON_BOX_SUCCESS}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              </span>
              <h1 className={V3_HEADING}>Your environment is ready!</h1>
              <p className={V3_BODY}>Check your email for login credentials.</p>
              <a href={`https://${host}`} className={`mt-6 no-underline ${V3_PRIMARY_BUTTON}`}>
                Go to your environment
              </a>
              <p className={`mt-2.5 text-center ${V3_MONO}`}>https://{host}</p>
            </>
          )}

          {status === 'failed' && (
            <>
              <span className={V3_ICON_BOX_DANGER}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </span>
              <h1 className={V3_HEADING}>Something went wrong</h1>
              <p className={V3_BODY}>Our team has been notified. Please contact support if this persists.</p>
            </>
          )}

          {status === 'error' && (
            <>
              <span className={V3_ICON_BOX_DANGER}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </span>
              <h1 className={V3_HEADING}>Unable to check provisioning status</h1>
              <p className={V3_BODY}>Please try refreshing the page. Contact support if this persists.</p>
            </>
          )}
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout classic="bare">
      <div className="max-w-md w-full p-8 bg-white rounded-lg shadow-md text-center">
        {status === 'provisioning' && (
          <>
            <div className="mx-auto mb-6 h-12 w-12 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600" />
            <h1 className="text-xl font-semibold text-gray-900 mb-2">
              Setting up your environment
            </h1>
            <p className="text-gray-600">
              Your environment is being set up. This usually takes a few minutes.
            </p>
          </>
        )}

        {status === 'active' && (
          <>
            <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold text-gray-900 mb-2">
              Your environment is ready!
            </h1>
            <p className="text-gray-600 mb-6">
              Check your email for login credentials.
            </p>
            <a
              href={`https://${host}`}
              className="inline-block rounded-md bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-blue-500"
            >
              Go to your environment
            </a>
          </>
        )}

        {status === 'failed' && (
          <>
            <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
              <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold text-gray-900 mb-2">
              Something went wrong
            </h1>
            <p className="text-gray-600">
              Our team has been notified. Please contact support if this persists.
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="mx-auto mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
              <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold text-gray-900 mb-2">
              Unable to check provisioning status
            </h1>
            <p className="text-gray-600">
              Please try refreshing the page. Contact support if this persists.
            </p>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
