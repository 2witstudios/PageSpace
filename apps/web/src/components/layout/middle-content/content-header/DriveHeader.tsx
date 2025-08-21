'use client';

import React from 'react';

interface DriveHeaderProps {
  title: string;
  children?: React.ReactNode;
}

/**
 * Drive header component for workspace/drive pages with tabs
 * Used for drive pages that need tabs but don't have breadcrumbs
 */
export function DriveHeader({ title, children }: DriveHeaderProps) {
  return (
    <div className="flex flex-col p-4 border-b bg-card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">{title}</h1>
        </div>
        <div className="flex items-center gap-2">
          {children}
        </div>
      </div>
    </div>
  );
}

export default DriveHeader;