'use client';

import { motion } from 'motion/react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ExternalAuthWaitingProps {
  provider: 'google' | 'apple' | null;
  onCancel: () => void;
}

export function ExternalAuthWaiting({ provider, onCancel }: ExternalAuthWaitingProps) {
  const providerName = provider === 'google' ? 'Google' : provider === 'apple' ? 'Apple' : 'your browser';

  return (
    <motion.div
      className="flex flex-col items-center gap-4 py-6"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      <div className="text-center">
        <p className="text-sm font-medium text-foreground">
          Completing sign-in with {providerName}...
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          A browser window has been opened. Return here when done.
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onCancel}
        className="text-muted-foreground"
      >
        Cancel
      </Button>
    </motion.div>
  );
}
