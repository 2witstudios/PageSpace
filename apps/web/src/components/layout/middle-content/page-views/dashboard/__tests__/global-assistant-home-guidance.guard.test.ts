import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const globalAssistantView = readFileSync(
  resolve(
    process.cwd(),
    process.cwd().endsWith('/apps/web')
      ? 'src/components/layout/middle-content/page-views/dashboard/GlobalAssistantView.tsx'
      : 'apps/web/src/components/layout/middle-content/page-views/dashboard/GlobalAssistantView.tsx',
  ),
  'utf8',
);

describe('GlobalAssistantView home guidance', () => {
  it('keeps the full Home guidance in the empty state without mounting a conversation status strip', () => {
    expect(globalAssistantView).toContain('<HomeLine line={homeLine} />');
    expect(globalAssistantView).toContain('<HomeSuggestions suggestions={homeLine.suggestions} onSelect={setInput} />');
    expect(globalAssistantView).not.toContain('HomeStrip');
  });
});
