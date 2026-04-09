'use client';

import { use, useState } from 'react';
import useSWR from 'swr';

const TENANT_BASE_DOMAIN = process.env.NEXT_PUBLIC_TENANT_BASE_DOMAIN || 'pagespace.ai';

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Status check failed (${res.status})`);
  return res.json();
};

type ProvisioningStatus = {
  slug: string;
  status: 'provisioning' | 'active' | 'failed';
};

export default function ProvisioningStatusPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [lastStatus, setLastStatus] = useState<string>('provisioning');

  const { data, error } = useSWR<ProvisioningStatus>(
    `/api/provisioning-status/${slug}`,
    fetcher,
    {
      refreshInterval: 3000,
      isPaused: () => lastStatus === 'active' || lastStatus === 'failed',
      revalidateOnFocus: false,
      onSuccess: (d) => setLastStatus(d.status),
    }
  );

  const status: 'provisioning' | 'active' | 'failed' | 'error' = error
    ? 'error'
    : (data?.status ?? 'provisioning');

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
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
              href={`https://${slug}.${TENANT_BASE_DOMAIN}`}
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
    </div>
  );
}
