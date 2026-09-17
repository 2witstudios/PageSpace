/**
 * Guideline 5.1.2(i) asks apps to name where personal data goes, third-party AI
 * included, and get permission before sharing it. PageSpace does that where
 * people already give consent — the signup lines — rather than interrupting the
 * first AI message with a modal, which is how Notion and Perplexity disclose it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../..');
const CONSENT_SURFACES = [
  'components/auth/OAuthButtons.tsx',
  'components/auth/MagicLinkForm.tsx',
  'components/auth/PasskeySignupButton.tsx',
];

describe('signup consent names third-party AI', () => {
  for (const file of CONSENT_SURFACES) {
    it(`given ${file}, should say AI features send content to third-party AI providers`, () => {
      const source = readFileSync(join(SRC, file), 'utf8');
      expect(source).toMatch(/third-party AI providers/);
    });
  }

  it('given the app, should no longer gate the first AI message behind a disclosure dialog', () => {
    expect(() => readFileSync(join(SRC, 'hooks/useAiDisclosureGate.tsx'), 'utf8')).toThrow();
  });
});
