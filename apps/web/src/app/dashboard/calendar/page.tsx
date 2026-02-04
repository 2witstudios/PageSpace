'use client';

import { Suspense } from 'react';
import { CalendarView } from '@/components/calendar';
import { Skeleton } from '@/components/ui/skeleton';

function CalendarPageContent() {
  return (
    <div className="h-full flex flex-col">
      <CalendarView context="user" />
    </div>
  );
}

export default function CalendarPage() {
  return (
    <Suspense
      fallback={
        <div className="h-full overflow-y-auto">
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <Skeleton className="h-8 w-48" />
              <div className="flex gap-2">
                <Skeleton className="h-10 w-24" />
                <Skeleton className="h-10 w-24" />
              </div>
            </div>
            <Skeleton className="h-[600px]" />
          </div>
        </div>
      }
    >
      <CalendarPageContent />
    </Suspense>
  );
}
