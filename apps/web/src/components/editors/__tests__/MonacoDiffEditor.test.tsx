import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockUseMonaco, mockUseMonacoTheme, mockConfigureMonacoLoader } = vi.hoisted(() => ({
  mockUseMonaco: vi.fn(),
  mockUseMonacoTheme: vi.fn(),
  mockConfigureMonacoLoader: vi.fn(),
}));

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: (props: {
    language: string;
    theme: string;
    original: string;
    modified: string;
  }) => (
    <div
      data-testid="mock-diff-editor"
      data-language={props.language}
      data-theme={props.theme}
      data-original={props.original}
      data-modified={props.modified}
    />
  ),
  useMonaco: () => mockUseMonaco(),
}));

vi.mock('@/hooks/useMonacoTheme', () => ({
  useMonacoTheme: () => mockUseMonacoTheme(),
}));

vi.mock('@/lib/editor/monaco/loader-config', () => ({
  configureMonacoLoader: () => mockConfigureMonacoLoader(),
}));

import MonacoDiffEditor from '../MonacoDiffEditor';

describe('MonacoDiffEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMonaco.mockReturnValue(null);
    mockUseMonacoTheme.mockReturnValue('vs');
  });

  it('passes original and modified text through to the diff editor', () => {
    render(<MonacoDiffEditor original="const a = 1;" modified="const a = 2;" />);
    const editor = screen.getByTestId('mock-diff-editor');
    expect(editor.getAttribute('data-original')).toBe('const a = 1;');
    expect(editor.getAttribute('data-modified')).toBe('const a = 2;');
  });

  it('detects language from filename when no explicit language is given', () => {
    render(<MonacoDiffEditor original="a" modified="b" filename="app.tsx" />);
    expect(screen.getByTestId('mock-diff-editor').getAttribute('data-language')).toBe('typescript');
  });

  it('falls back to plaintext when neither language nor filename is given', () => {
    render(<MonacoDiffEditor original="a" modified="b" />);
    expect(screen.getByTestId('mock-diff-editor').getAttribute('data-language')).toBe('plaintext');
  });

  it('an explicit language prop takes precedence over filename detection', () => {
    render(<MonacoDiffEditor original="a" modified="b" filename="app.tsx" language="markdown" />);
    expect(screen.getByTestId('mock-diff-editor').getAttribute('data-language')).toBe('markdown');
  });

  it('wires the resolved theme from useMonacoTheme into the diff editor', () => {
    mockUseMonacoTheme.mockReturnValue('pagespace-dark');
    render(<MonacoDiffEditor original="a" modified="b" />);
    expect(screen.getByTestId('mock-diff-editor').getAttribute('data-theme')).toBe('pagespace-dark');
  });
});
