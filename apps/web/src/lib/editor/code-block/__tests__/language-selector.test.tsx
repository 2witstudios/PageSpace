import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { assert } from '@/test/riteway';
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
    expect(select, 'Given rendered selector, should find the select element').toBeTruthy();

    const options = Array.from(select.options).map((o) => o.value);
    expect(options, 'Given language options, should include sudolang').toContain('sudolang');
    expect(options, 'Given language options, should include javascript').toContain('javascript');
    expect(options, 'Given language options, should include typescript').toContain('typescript');
    expect(options, 'Given language options, should include python').toContain('python');
  });

  it('selecting a language calls updateAttributes', () => {
    const props = createMockProps();
    render(<LanguageSelector {...props} />);
    const select = screen.getByLabelText('Select language') as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'sudolang' } });
    assert({
      given: 'selecting sudolang from dropdown',
      should: 'call updateAttributes with sudolang',
      actual: (props.updateAttributes as ReturnType<typeof vi.fn>).mock.calls[0][0],
      expected: { language: 'sudolang' },
    });
  });

  it('displays current language when set', () => {
    const props = createMockProps('javascript');
    render(<LanguageSelector {...props} />);
    const select = screen.getByLabelText('Select language') as HTMLSelectElement;
    assert({
      given: 'language set to javascript',
      should: 'show javascript as selected value',
      actual: select.value,
      expected: 'javascript',
    });
  });

  it('shows plain text when no language set', () => {
    const props = createMockProps(null);
    render(<LanguageSelector {...props} />);
    const select = screen.getByLabelText('Select language') as HTMLSelectElement;
    assert({
      given: 'no language set',
      should: 'have empty string as value',
      actual: select.value,
      expected: '',
    });
    const selectedOption = select.options[select.selectedIndex];
    assert({
      given: 'no language set',
      should: 'display Plain text as option text',
      actual: selectedOption.text,
      expected: 'Plain text',
    });
  });
});
