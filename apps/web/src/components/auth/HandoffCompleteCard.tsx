'use client';

import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type HandoffCompleteVariant = 'signed-in' | 'passkey-added';

interface HandoffCompleteCardProps {
  variant: HandoffCompleteVariant;
}

const COPY: Record<HandoffCompleteVariant, { title: string; body: string }> = {
  'signed-in': {
    title: "You're signed in",
    body: 'Return to the PageSpace desktop app — you can safely close this window.',
  },
  'passkey-added': {
    title: 'Passkey added',
    body: 'Return to the PageSpace desktop app — you can safely close this window.',
  },
};

export function HandoffCompleteCard({ variant }: HandoffCompleteCardProps) {
  const { title, body } = COPY[variant];

  const handleClose = () => {
    window.close();
  };

  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <CheckCircle2 className="h-10 w-10 text-emerald-500" />
      <div>
        <p className="text-base font-medium text-foreground">{title}</p>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      </div>
      <Button variant="outline" size="sm" onClick={handleClose} className="mt-2">
        Close window
      </Button>
    </div>
  );
}
