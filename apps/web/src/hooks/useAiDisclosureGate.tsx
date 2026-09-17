'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { MarketingLink } from '@/components/ui/MarketingLink';
import { isCapacitorApp } from '@/lib/capacitor-bridge';
import { acknowledgeAiDisclosure, hasAcknowledgedAiDisclosure, needsAiDisclosure } from '@/lib/ai/ai-disclosure';

/**
 * Gate an action that sends data to an AI provider behind the one-time
 * third-party AI disclosure. Render `aiDisclosureDialog` alongside the control.
 */
export function useAiDisclosureGate(): {
  requestAiConsent: (proceed: () => void) => void;
  aiDisclosureDialog: ReactNode;
} {
  const [open, setOpen] = useState(false);
  const pendingRef = useRef<(() => void) | null>(null);

  const requestAiConsent = useCallback((proceed: () => void) => {
    if (!needsAiDisclosure({ isNative: isCapacitorApp(), acknowledged: hasAcknowledgedAiDisclosure() })) {
      proceed();
      return;
    }
    pendingRef.current = proceed;
    setOpen(true);
  }, []);

  const agree = () => {
    acknowledgeAiDisclosure();
    setOpen(false);
    const proceed = pendingRef.current;
    pendingRef.current = null;
    proceed?.();
  };

  const decline = () => {
    pendingRef.current = null;
    setOpen(false);
  };

  const aiDisclosureDialog = (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) decline(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>AI features use third-party providers</AlertDialogTitle>
          <AlertDialogDescription>
            To answer you, PageSpace sends what you ask — your message, any images or files you attach, and the page
            content you include — to the third-party AI provider for the model you use (such as Anthropic, OpenAI,
            Google, or xAI). They process it to generate a response and do not use it to train their models. Nothing is
            sent until you continue. See our <MarketingLink href="/privacy" className="underline">Privacy Policy</MarketingLink>.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={decline}>Not now</AlertDialogCancel>
          <Button onClick={agree}>Agree and continue</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { requestAiConsent, aiDisclosureDialog };
}
