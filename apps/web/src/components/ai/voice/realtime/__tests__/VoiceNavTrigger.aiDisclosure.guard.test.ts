import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A voice call streams microphone audio to a third-party AI provider, so it goes
// through the same disclosure gate as a typed message (Guideline 5.1.2(i)).
describe('VoiceNavTrigger', () => {
  it('given a call is started, should go through the AI disclosure gate first', () => {
    const source = readFileSync(join(__dirname, '../VoiceNavTrigger.tsx'), 'utf8');
    expect(source).toMatch(/useAiDisclosureGate\(\)/);
    expect(source).toMatch(/requestAiConsent\(/);
  });
});
