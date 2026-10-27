'use client';

import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isV3AuthEnabled } from '@/lib/imago/v3-auth-enabled';
import { AuthStatusCard } from './AuthStatusCard';

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

const V3_TITLE: Record<HandoffCompleteVariant, string> = {
  'signed-in': 'You’re signed in',
  'passkey-added': 'Passkey added',
};

export function HandoffCompleteCard({ variant }: HandoffCompleteCardProps) {
  const { title, body } = COPY[variant];

  const handleClose = () => {
    window.close();
  };

  if (isV3AuthEnabled()) {
    return (
      <AuthStatusCard
        icon={<CheckCircle2 className="h-5 w-5" />}
        title={V3_TITLE[variant]}
      >
        <p>{body}</p>
      </AuthStatusCard>
    );
  }

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
