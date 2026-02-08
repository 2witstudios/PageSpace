import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { LanguageSelector } from '../LanguageSelector';
import type { NodeViewProps } from '@tiptap/react';

function createMockProps(language: string | null = null): NodeViewProps {
  return {
    node: {
      attrs: { language },
      type: { name: 'codeBlock' },
    },
    updateAttributes: vi.fn(),
    extension: {} as NodeViewProps['extension'],
    editor: {} as NodeViewProps['editor'],
    getPos: (() => 0) as NodeViewProps['getPos'],
    decorations: [],
    selected: false,
    deleteNode: vi.fn(),
    HTMLAttributes: {},
    innerDecorations: [] as unknown as NodeViewProps['innerDecorations'],
  } as unknown as NodeViewProps;
}

describe('LanguageSelector', () => {
  it('renders dropdown with common languages including sudolang', () => {
    const props = createMockProps();
    render(<LanguageSelector {...props} />);
    const select = screen.getByLabelText('Select language') as HTMLSelectElement;
    expect(select).toBeTruthy();

    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('sudolang');
    expect(options).toContain('javascript');
    expect(options).toContain('typescript');
    expect(options).toContain('python');
  });

  it('selecting a language calls updateAttributes', () => {
    const props = createMockProps();
    render(<LanguageSelector {...props} />);
    const select = screen.getByLabelText('Select language') as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'sudolang' } });
    expect(props.updateAttributes).toHaveBeenCalledWith({ language: 'sudolang' });
  });

  it('displays current language when set', () => {
    const props = createMockProps('javascript');
    render(<LanguageSelector {...props} />);
    const select = screen.getByLabelText('Select language') as HTMLSelectElement;
    expect(select.value).toBe('javascript');
  });

  it('shows plain text when no language set', () => {
    const props = createMockProps(null);
    render(<LanguageSelector {...props} />);
    const select = screen.getByLabelText('Select language') as HTMLSelectElement;
    expect(select.value).toBe('');
    const selectedOption = select.options[select.selectedIndex];
    expect(selectedOption.text).toBe('Plain text');
  });
});
