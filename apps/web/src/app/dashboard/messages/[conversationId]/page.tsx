'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function ConversationRedirectPage() {
  const router = useRouter();
  const params = useParams();
  const conversationId = params.conversationId as string;

  useEffect(() => {
    router.replace(`/dashboard/inbox/dm/${conversationId}`);
  }, [router, conversationId]);

  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-muted-foreground">Redirecting to inbox...</p>
      </div>
    </div>
  );
}
