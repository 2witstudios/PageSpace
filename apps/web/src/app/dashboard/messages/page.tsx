'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function MessagesPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/dashboard/inbox');
  }, [router]);

  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-muted-foreground">Redirecting to inbox...</p>
      </div>
    </div>
  );
}
