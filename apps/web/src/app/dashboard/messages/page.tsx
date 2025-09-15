'use client';

import { MessageSquare } from 'lucide-react';

export default function MessagesPage() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center">
        <MessageSquare className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h2 className="text-xl font-semibold mb-2">Your Messages</h2>
        <p className="text-muted-foreground">
          Select a conversation from the sidebar or start a new one
        </p>
      </div>
    </div>
  );
}