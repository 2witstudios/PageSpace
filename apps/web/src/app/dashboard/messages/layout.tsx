'use client';

import MessagesLeftSidebar from '@/components/layout/left-sidebar/MessagesLeftSidebar';

export default function MessagesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full w-full">
      <MessagesLeftSidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}