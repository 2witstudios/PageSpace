'use client';

import { Suspense, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import ChannelsCenterList from '@/components/inbox/ChannelsCenterList';
import { legacyFocusHref } from '@/lib/dashboard/focus';

function ChannelsPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // `/dashboard/channels?driveId=…` predates the drive focus. It means what
  // `/dashboard/[driveId]/channels` means, and rendering it here would show a
  // drive's list under an "All drives" sidebar, so it goes there instead.
  const legacyHref = legacyFocusHref(pathname, searchParams);
  useEffect(() => {
    if (legacyHref) {
      router.replace(legacyHref);
    }
  }, [legacyHref, router]);

  if (legacyHref) return null;
  return <ChannelsCenterList />;
}

export default function ChannelsPage() {
  return (
    <Suspense fallback={null}>
      <ChannelsPageContent />
    </Suspense>
  );
}
