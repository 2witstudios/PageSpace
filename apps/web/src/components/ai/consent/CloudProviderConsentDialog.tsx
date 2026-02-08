'use client';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { AI_PROVIDERS } from '@/lib/ai/core/ai-providers-config';

const PROVIDER_PRIVACY_URLS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/privacy',
  openrouter_free: 'https://openrouter.ai/privacy',
  google: 'https://ai.google.dev/gemini-api/terms',
  openai: 'https://openai.com/policies/privacy-policy',
  anthropic: 'https://www.anthropic.com/privacy',
  xai: 'https://x.ai/legal/privacy-policy',
  glm: 'https://z.ai/privacy',
  minimax: 'https://www.minimax.io/privacy',
};

interface CloudProviderConsentDialogProps {
  provider: string | null;
  onConsent: () => void;
  onCancel: () => void;
}

export function CloudProviderConsentDialog({
  provider,
  onConsent,
  onCancel,
}: CloudProviderConsentDialogProps) {
  if (!provider) return null;

  const providerConfig = AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS];
  const providerName = providerConfig?.name || provider;
  const privacyUrl = PROVIDER_PRIVACY_URLS[provider];

  return (
    <AlertDialog open={!!provider} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Data sharing consent required</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                Using <strong>{providerName}</strong> will send your messages to their servers for processing.
                Your conversation data will be handled according to their privacy policy.
              </p>
              {privacyUrl && (
                <p>
                  <a
                    href={privacyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    View {providerName} privacy policy
                  </a>
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                You can revoke consent at any time from Settings.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConsent}>
            I understand and consent
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
