"use client";

import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import DrivesBrowser from "@/components/drives/DrivesBrowser";

function DrivesSkeleton() {
  return (
    <div className="container mx-auto px-4 py-10 sm:px-6 lg:px-10">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-32" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-9" />
            <Skeleton className="h-9 w-9" />
            <Skeleton className="h-9 w-28" />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function DrivesPage() {
  return (
    <Suspense fallback={<DrivesSkeleton />}>
      <DrivesBrowser />
    </Suspense>
  );
}
