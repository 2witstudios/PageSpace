'use client';

import { Inbox } from 'lucide-react';

export default function InboxPage() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center -mt-20">
        <Inbox className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">Your Inbox</h2>
        <p className="text-muted-foreground">
          Select a conversation from the sidebar to start chatting
        </p>
      </div>
    </div>
  );
}
