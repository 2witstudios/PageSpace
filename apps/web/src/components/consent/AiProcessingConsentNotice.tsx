'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAiProcessingConsent } from '@/hooks/useAiProcessingConsent';

/**
 * Capture UI for AI-processing consent (GDPR Art 13(1)(e)(f), Art 7(1), Art 44).
 *
 * Surfaces a notice that prompts leave the platform and are processed by external AI
 * providers (potentially outside the EU), and records the user's explicit consent.
 * Renders nothing once valid consent exists. Thin shell — the record + validity logic
 * is the pure @pagespace/lib/consent core behind /api/consent/ai-processing.
 */
export function AiProcessingConsentNotice() {
  const { consented, isLoading, grant } = useAiProcessingConsent();
  const [saving, setSaving] = useState(false);

  if (isLoading || consented) return null;

  const onConsent = async () => {
    setSaving(true);
    try {
      await grant();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="region"
      aria-label="AI processing consent"
      className="rounded-lg border border-border bg-muted/40 p-4 text-sm"
    >
      <p className="font-medium">Before you use AI features</p>
      <p className="mt-1 text-muted-foreground">
        Your prompts and the content you ask AI to work with are sent to external AI providers for
        processing. These providers may be located outside the European Union. We only do this with
        your consent.
      </p>
      <Button size="sm" className="mt-3" onClick={onConsent} disabled={saving}>
        {saving ? 'Saving…' : 'I understand and consent'}
      </Button>
    </div>
  );
}

export default AiProcessingConsentNotice;
