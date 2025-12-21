'use client';

import { Suspense } from 'react';
import { ActivityDashboard } from '@/components/activity';
import { Skeleton } from '@/components/ui/skeleton';

function ActivityPageContent() {
  return <ActivityDashboard context="user" />;
}

export default function ActivityPage() {
  return (
    <Suspense
      fallback={
        <div className="h-full overflow-y-auto">
          <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10 max-w-5xl">
            <div className="space-y-6">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-96" />
            </div>
          </div>
        </div>
      }
    >
      <ActivityPageContent />
    </Suspense>
  );
}
