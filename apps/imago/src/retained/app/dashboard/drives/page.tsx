"use client";

import { Suspense } from "react";
import DrivesBrowser, { DrivesSkeleton } from "@/retained/components/drives/DrivesBrowser";

export default function DrivesPage() {
  return (
    <Suspense fallback={<DrivesSkeleton />}>
      <DrivesBrowser />
    </Suspense>
  );
}
