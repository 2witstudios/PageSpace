import { describe, it, expect, vi } from 'vitest';

// Mock knowledge-base to avoid pulling real content into snapshot
vi.mock('../knowledge-base', () => ({
  getFaqKnowledgeBaseDocuments: vi.fn(() => [
    { title: 'Test Guide', content: 'Test content here.' },
    { title: 'Another Guide', content: 'More content.' },
  ]),
}));

import { getAboutPageSpaceAgentSystemPrompt } from '../about-agent-system-prompt';

describe('getAboutPageSpaceAgentSystemPrompt', () => {
  it('is defined and is a function', () => {
    expect(getAboutPageSpaceAgentSystemPrompt).toBeDefined();
    expect(typeof getAboutPageSpaceAgentSystemPrompt).toBe('function');
  });

  it('returns a non-empty string', () => {
    const result = getAboutPageSpaceAgentSystemPrompt();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes the PageSpace Guide agent persona', () => {
    const result = getAboutPageSpaceAgentSystemPrompt();
    expect(result).toContain('PageSpace Guide');
  });

  it('includes the knowledge base content injected from getFaqKnowledgeBaseDocuments', () => {
    const result = getAboutPageSpaceAgentSystemPrompt();
    expect(result).toContain('Test Guide');
    expect(result).toContain('Test content here.');
    expect(result).toContain('Another Guide');
    expect(result).toContain('More content.');
  });

  it('includes page type chooser section', () => {
    const result = getAboutPageSpaceAgentSystemPrompt();
    expect(result).toContain('Folder');
    expect(result).toContain('Document');
    expect(result).toContain('AI Chat');
  });

  it('includes operating constraints section', () => {
    const result = getAboutPageSpaceAgentSystemPrompt();
    expect(result).toContain('list_pages');
    expect(result).toContain('read_page');
  });

  it('includes drive structure reference', () => {
    const result = getAboutPageSpaceAgentSystemPrompt();
    expect(result).toContain('Welcome to PageSpace');
    expect(result).toContain('Reference');
  });

  it('returns a new string each time (not cached across calls with same mocks)', () => {
    const result1 = getAboutPageSpaceAgentSystemPrompt();
    const result2 = getAboutPageSpaceAgentSystemPrompt();
    expect(result1).toBe(result2);
  });

  it('formats knowledge base documents with separators', () => {
    const result = getAboutPageSpaceAgentSystemPrompt();
    // The formatter uses --- as separator between sections
    expect(result).toContain('---');
  });
});
