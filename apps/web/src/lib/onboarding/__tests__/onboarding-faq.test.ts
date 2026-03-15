import { describe, it, expect, vi } from 'vitest';

// Mock the faq submodule to verify re-exports work
vi.mock('../faq', () => ({
  getAboutPageSpaceAgentSystemPrompt: vi.fn(() => 'mocked-system-prompt'),
  getFaqKnowledgeBaseDocuments: vi.fn(() => []),
  getReferenceSeedTemplate: vi.fn(() => ({ title: 'Reference', type: 'FOLDER', children: [] })),
  // Seed types are TypeScript-only, no runtime export needed
}));

import {
  getAboutPageSpaceAgentSystemPrompt,
  getFaqKnowledgeBaseDocuments,
  getReferenceSeedTemplate,
} from '../onboarding-faq';

describe('onboarding-faq re-exports', () => {
  it('re-exports getAboutPageSpaceAgentSystemPrompt from ./faq', () => {
    expect(getAboutPageSpaceAgentSystemPrompt).toBeDefined();
    expect(typeof getAboutPageSpaceAgentSystemPrompt).toBe('function');
  });

  it('re-exports getFaqKnowledgeBaseDocuments from ./faq', () => {
    expect(getFaqKnowledgeBaseDocuments).toBeDefined();
    expect(typeof getFaqKnowledgeBaseDocuments).toBe('function');
  });

  it('re-exports getReferenceSeedTemplate from ./faq', () => {
    expect(getReferenceSeedTemplate).toBeDefined();
    expect(typeof getReferenceSeedTemplate).toBe('function');
  });

  it('getAboutPageSpaceAgentSystemPrompt is callable and returns a value', () => {
    const result = getAboutPageSpaceAgentSystemPrompt();
    expect(result).toBe('mocked-system-prompt');
  });

  it('getFaqKnowledgeBaseDocuments is callable and returns an array', () => {
    const result = getFaqKnowledgeBaseDocuments();
    expect(Array.isArray(result)).toBe(true);
  });

  it('getReferenceSeedTemplate is callable and returns an object with title', () => {
    const result = getReferenceSeedTemplate();
    expect(result).toBeDefined();
    expect(result.title).toBe('Reference');
  });
});
